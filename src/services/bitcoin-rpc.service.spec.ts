import { BitcoinRpcService } from './bitcoin-rpc.service';

describe('BitcoinRpcService mempool summary', () => {
    let redisMessagingService: { getJsonCache: jest.Mock; setJsonCache: jest.Mock };
    let service: BitcoinRpcService;

    beforeEach(() => {
        redisMessagingService = {
            getJsonCache: jest.fn(),
            setJsonCache: jest.fn(),
        };

        service = new BitcoinRpcService(
            {} as any,
            {} as any,
            redisMessagingService as any,
        );
    });

    it('reads the mempool summary from Redis, never bitcoind, on a cache miss', async () => {
        redisMessagingService.getJsonCache.mockResolvedValue({ size: 29246, bytes: 28688909 });

        const result = await service.getMempoolSummary();

        expect(result).toEqual({ size: 29246, bytes: 28688909 });
        expect(redisMessagingService.getJsonCache).toHaveBeenCalledWith('mempoolInfo');
    });

    it('serves subsequent calls from the in-process cache within the TTL, without hitting Redis again', async () => {
        redisMessagingService.getJsonCache.mockResolvedValue({ size: 100, bytes: 1000 });

        await service.getMempoolSummary();
        await service.getMempoolSummary();
        await service.getMempoolSummary();

        expect(redisMessagingService.getJsonCache).toHaveBeenCalledTimes(1);
    });

    it('re-reads Redis once the in-process cache TTL has elapsed', async () => {
        process.env.MEMPOOL_SUMMARY_CACHE_TTL_MS = '10';
        const ttlService = new BitcoinRpcService({} as any, {} as any, redisMessagingService as any);
        redisMessagingService.getJsonCache.mockResolvedValue({ size: 1, bytes: 1 });

        await ttlService.getMempoolSummary();
        await new Promise(resolve => setTimeout(resolve, 20));
        await ttlService.getMempoolSummary();

        expect(redisMessagingService.getJsonCache).toHaveBeenCalledTimes(2);
        delete process.env.MEMPOOL_SUMMARY_CACHE_TTL_MS;
    });

    it('returns null when nothing has been published to Redis yet', async () => {
        redisMessagingService.getJsonCache.mockResolvedValue(null);

        expect(await service.getMempoolSummary()).toBeNull();
    });

    it('getMempoolInfo calls getmempoolinfo over RPC and returns the raw result', async () => {
        const post = jest.fn().mockResolvedValue({ data: { result: { size: 29246, bytes: 28688909 } } });
        (service as any).client = { post };

        const result = await service.getMempoolInfo();

        expect(result).toEqual({ size: 29246, bytes: 28688909 });
        expect(post.mock.calls[0][1].method).toBe('getmempoolinfo');
    });

    it('getMempoolInfo returns null (not a thrown error) when the RPC call fails', async () => {
        const post = jest.fn().mockRejectedValue(new Error('connection refused'));
        (service as any).client = { post };

        expect(await service.getMempoolInfo()).toBeNull();
    });
});
