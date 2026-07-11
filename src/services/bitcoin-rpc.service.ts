import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { asyncScheduler, BehaviorSubject, delay, filter, from, interval, scheduled, shareReplay, startWith, Subject, switchMap } from 'rxjs';
import { PayoutSnapshotService } from '../ORM/payout-snapshot/payout-snapshot.service';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';
import * as zmq from 'zeromq';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMempoolInfo } from '../models/bitcoin-rpc/IMempoolInfo';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';
import { RedisMessagingService } from './redis-messaging.service';

const MEMPOOL_INFO_CACHE_KEY = 'mempoolInfo';
// Master refreshes this every ~60s (see resetTemplateInterval$); TTL covers a
// couple of missed cycles before other processes see it go stale.
const MEMPOOL_INFO_REDIS_TTL_MS = 120_000;

@Injectable()
export class BitcoinRpcService implements OnModuleInit {


    private client: AxiosInstance;
    private _newBlockTemplate$: BehaviorSubject<IBlockTemplate> = new BehaviorSubject(undefined);
    private resetTemplateInterval$ = new Subject<void>();
    private rpcRequestId = 0;

    private readonly mempoolSummaryCacheTtlMs = this.readPositiveInt('MEMPOOL_SUMMARY_CACHE_TTL_MS', 5000);
    private cachedMempoolInfo: IMempoolInfo | null = null;
    private cachedMempoolInfoAt = 0;

    public miningInfo: IMiningInfo;
    public newBlockTemplate$ = this._newBlockTemplate$.pipe(filter(block => block != null), shareReplay({ refCount: true, bufferSize: 1 }));

    constructor(
        private readonly configService: ConfigService,
        private rpcBlockService: RpcBlockService,
        private readonly redisMessagingService: RedisMessagingService,
        @Optional()
        private readonly payoutSnapshotService?: PayoutSnapshotService
    ) {

    }

    async onModuleInit() {

        const url = this.configService.get('BITCOIN_RPC_URL');
        const user = this.configService.get('BITCOIN_RPC_USER');
        const pass = this.configService.get('BITCOIN_RPC_PASSWORD');
        const port = parseInt(this.configService.get('BITCOIN_RPC_PORT'));
        const timeout = parseInt(this.configService.get('BITCOIN_RPC_TIMEOUT'));

        const baseURL = this.buildRpcUrl(url, port);
        this.client = axios.create({
            baseURL,
            timeout,
            auth: {
                username: user,
                password: pass
            }
        });

        console.log(`MASTER? ${process.env.MASTER}`)
        if (process.env.MASTER != 'true') {
            await this.loadLatestMiningInfoForReplayProcess();
            if (process.env.API_ONLY != 'true') {
                await this.loadLatestTemplateForWorker();
            }
            await this.redisMessagingService.subscribeMiningInfoUpdates(async (miningInfo: IMiningInfo) => {
                this.miningInfo = miningInfo;
                if (process.env.API_ONLY != 'true') {
                    await this.loadTemplateForWorker(miningInfo.blocks);
                }
            });
            if (process.env.API_ONLY == 'true') {
                console.log('API-only process using Redis mining info replay');
            }
            return;
        } else {
            this.callRpc('getrpcinfo').then((res) => {
                console.log('Bitcoin RPC connected');
            }, () => {
                console.error('Could not reach RPC host');
            });

            this.miningInfo = await this.getMiningInfo();
            console.log('Using ZMQ');
            const sock = new zmq.Subscriber;

            sock.connectTimeout = 1000;
            sock.events.on('connect', () => {
                console.log('ZMQ Connected');
            });
            sock.events.on('connect:retry', () => {
                console.error('ZMQ Unable to connect, Retrying');
            });

            sock.connect(this.configService.get('BITCOIN_ZMQ_HOST'));
            sock.subscribe('rawblock');
            // Don't await this, otherwise it will block the rest of the program
            this.listenForNewBlocks(sock);

            // Between new blocks we want refresh jobs with the latest transactions
            this.resetTemplateInterval$.pipe(
                startWith(null),
                switchMap(() =>interval(60000))
            ).subscribe(async () =>{
                await this.getAndBroadcastLatestTemplate();
            });

        }

    }

    private async loadLatestMiningInfoForReplayProcess() {
        const latestMiningInfo = await this.redisMessagingService.getLatestMiningInfo();
        if (latestMiningInfo != null) {
            this.miningInfo = latestMiningInfo;
        }
    }

    private async listenForNewBlocks(sock: zmq.Subscriber) {
        for await (const [topic, msg] of sock) {
            console.log("New Block");
            this.miningInfo = await this.getMiningInfo();
            await this.getAndBroadcastLatestTemplate();

            //Reset the block update interval
            this.resetTemplateInterval$.next();
        }
    }

    public async getAndBroadcastLatestTemplate() {
        if (this.miningInfo?.blocks == null) {
            console.warn('Skipping block template broadcast because mining info is not available');
            return;
        }

        const blockTemplate = await this.loadBlockTemplate(this.miningInfo.blocks);
        if (blockTemplate == null) {
            console.warn(`Skipping block template broadcast for height ${this.miningInfo.blocks}; block template is not available`);
            return;
        }

        this._newBlockTemplate$.next(blockTemplate);
        await this.redisMessagingService.setLatestMiningInfo(this.miningInfo);
        await this.redisMessagingService.setBlockTemplate(this.miningInfo.blocks, blockTemplate);
        await this.redisMessagingService.publishMiningInfoUpdate(this.miningInfo);

        await this.refreshMempoolInfo();
    }

    // Piggybacks on the same trigger as the template refresh (new block via ZMQ,
    // plus the 60s resetTemplateInterval$ between blocks) rather than running its
    // own polling loop. getmempoolinfo is cheap, and mempool depth changes
    // continuously rather than only per-block, so the template's ~60s cadence
    // (not the ~10min block cadence) is the better fit.
    private async refreshMempoolInfo(): Promise<void> {
        const mempoolInfo = await this.getMempoolInfo();
        if (mempoolInfo == null) {
            return;
        }

        await this.redisMessagingService.setJsonCache(MEMPOOL_INFO_CACHE_KEY, mempoolInfo, MEMPOOL_INFO_REDIS_TTL_MS);
    }

    private async loadLatestTemplateForWorker() {
        const latestMiningInfo = await this.redisMessagingService.getLatestMiningInfo();
        if (latestMiningInfo != null) {
            this.miningInfo = latestMiningInfo;
            await this.loadTemplateForWorker(latestMiningInfo.blocks);
            return;
        }

        const latestBlockTemplate = await this.redisMessagingService.getLatestBlockTemplate();
        if (latestBlockTemplate != null) {
            this._newBlockTemplate$.next(latestBlockTemplate);
        }
    }

    private async loadTemplateForWorker(blockHeight: number) {
        const redisBlockTemplate = await this.redisMessagingService.getBlockTemplate(blockHeight);
        if (redisBlockTemplate != null) {
            this._newBlockTemplate$.next(redisBlockTemplate);
            return;
        }

        const savedBlockTemplate = await this.rpcBlockService.getSavedBlockTemplate(blockHeight);
        if (savedBlockTemplate?.data != null) {
            this._newBlockTemplate$.next(JSON.parse(savedBlockTemplate.data));
        }
    }

    private async loadBlockTemplate(blockHeight: number) {

        console.log(`Master fetching block template ${blockHeight}`);

        let blockTemplate: IBlockTemplate;
        while (blockTemplate == null) {
            try {
                blockTemplate = await this.callRpc<IBlockTemplate>('getblocktemplate', [
                    {
                        rules: ['segwit'],
                        mode: 'template',
                        capabilities: ['serverlist', 'proposal']
                    }
                ]);
            } catch (e) {
                console.warn(`Block template is not available yet: ${e.message ?? e}`);
                await new Promise(resolve => setTimeout(resolve, 10_000));
            }
        }

        try {
            const payoutSnapshot = await this.payoutSnapshotService?.createSnapshotForTemplate({
                blockHeight,
                coinbaseValueSats: blockTemplate.coinbasevalue,
                networkDifficulty: this.calculateNetworkDifficulty(parseInt(blockTemplate.bits, 16)),
            });
            if (payoutSnapshot != null) {
                blockTemplate.payoutSnapshotId = payoutSnapshot.id;
                blockTemplate.payoutOutputs = payoutSnapshot.payoutOutputs;
            }
        } catch (e) {
            console.error('Error creating payout snapshot', e);
        }

        try {
            console.log(`Saving block ${blockHeight}`);
            await this.rpcBlockService.saveBlock(blockHeight, JSON.stringify(blockTemplate));
            console.log('block saved');
        } catch (e) {
            console.error('Error saving block', e);
        }

        return blockTemplate;
    }

    public async getMiningInfo(): Promise<IMiningInfo> {
        try {
            return await this.callRpc<IMiningInfo>('getmininginfo');
        } catch (e) {
            console.error('Error getmininginfo', e.message);
            return null;
        }

    }

    public async getMempoolInfo(): Promise<IMempoolInfo | null> {
        try {
            return await this.callRpc<IMempoolInfo>('getmempoolinfo');
        } catch (e) {
            console.error('Error getmempoolinfo', e.message);
            return null;
        }
    }

    // Read path for API workers: never calls bitcoind directly, only Redis (written
    // by the master process above), with a short in-process cache on top so a burst
    // of API requests doesn't hit Redis every time. Same shape as
    // TemplateProviderService.getCurrentTemplateSummary().
    public async getMempoolSummary(): Promise<IMempoolInfo | null> {
        const now = Date.now();
        if (this.cachedMempoolInfo != null && (now - this.cachedMempoolInfoAt) < this.mempoolSummaryCacheTtlMs) {
            return this.cachedMempoolInfo;
        }

        const mempoolInfo = await this.redisMessagingService.getJsonCache<IMempoolInfo>(MEMPOOL_INFO_CACHE_KEY);
        this.cachedMempoolInfo = mempoolInfo;
        this.cachedMempoolInfoAt = now;
        return mempoolInfo;
    }

    public async SUBMIT_BLOCK(hexdata: string): Promise<string> {
        let response: string = 'unknown';
        try {
            response = await this.callRpc<string>('submitblock', [hexdata]);
            if (response == null) {
                response = 'SUCCESS!';
            }
            console.log(`BLOCK SUBMISSION RESPONSE: ${response}`);
            console.log(hexdata);
            console.log(JSON.stringify(response));
        } catch (e) {
            response = e instanceof Error ? e.message : String(e);
            console.log(`BLOCK SUBMISSION RESPONSE ERROR: ${response}`);
        }
        return response;

    }

    public async TEST_MEMPOOL_ACCEPT(rawTransactions: Buffer[]): Promise<Array<{
        txid?: string;
        wtxid?: string;
        allowed: boolean;
        rejectReason?: string;
        rejectDetails?: string;
    }>> {
        return this.callRpc('testmempoolaccept', [
            rawTransactions.map(tx => tx.toString('hex')),
        ]);
    }

    private async callRpc<T>(method: string, params: unknown[] = []): Promise<T> {
        const response = await this.client.post('', {
            jsonrpc: '1.0',
            id: ++this.rpcRequestId,
            method,
            params
        });

        if (response.data.error != null) {
            throw response.data.error;
        }

        return response.data.result;
    }

    private calculateNetworkDifficulty(nBits: number) {
        const mantissa: number = nBits & 0x007fffff;
        const exponent: number = (nBits >> 24) & 0xff;
        const target: number = mantissa * Math.pow(256, (exponent - 3));
        const maxTarget = Math.pow(2, 208) * 65535;
        return maxTarget / target;
    }

    private buildRpcUrl(url: string, port: number): string {
        const normalizedUrl = /^https?:\/\//i.test(url) ? url : `http://${url}`;
        const rpcUrl = new URL(normalizedUrl);
        if (Number.isFinite(port) && port > 0) {
            rpcUrl.port = port.toString();
        }
        return rpcUrl.toString();
    }

    private readPositiveInt(name: string, defaultValue: number): number {
        const value = Number(process.env[name]);
        return Number.isInteger(value) && value > 0 ? value : defaultValue;
    }
}
