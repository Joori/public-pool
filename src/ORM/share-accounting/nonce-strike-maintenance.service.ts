import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

interface StrikeCandidate {
    nonce: string;
    submissionDifficulty: string;
    acceptedAt: Date;
    blockHeight: string | null;
    isBlockCandidate: boolean;
    blockSubmissionResult: string | null;
    address: string | null;
    clientName: string | null;
}

export interface NonceStrikeRefreshResult {
    processed: boolean;
    reason?: 'locked';
    capturedRows: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INITIAL_SEED_DELAY_MS = 30_000;
const DEFAULT_KEEP_COUNT = 50;
// accepted_share_entity has a 7-day retention policy (see AcceptedShareRetentionCompression),
// so this durably captures top-difficulty shares before their raw rows get dropped. A daily
// cadence leaves ~6 days of margin against that drop.
const NONCE_STRIKE_ADVISORY_LOCK = '1781321000';

@Injectable()
export class NonceStrikeMaintenanceService implements OnModuleInit, OnModuleDestroy {
    private timer: NodeJS.Timeout | null = null;
    private activeRefresh: Promise<NonceStrikeRefreshResult> | null = null;
    private readonly refreshIntervalMs = this.readPositiveInt(
        'NONCE_STRIKE_REFRESH_INTERVAL_MS',
        DEFAULT_REFRESH_INTERVAL_MS,
    );
    private readonly initialSeedDelayMs = this.readPositiveInt(
        'NONCE_STRIKE_INITIAL_SEED_DELAY_MS',
        DEFAULT_INITIAL_SEED_DELAY_MS,
    );
    private readonly keepCount = this.readPositiveInt(
        'NONCE_STRIKE_KEEP_COUNT',
        DEFAULT_KEEP_COUNT,
    );

    constructor(private readonly dataSource: DataSource) { }

    public onModuleInit(): void {
        if (process.env.MASTER !== 'true' || process.env.API_ONLY === 'true') {
            return;
        }

        this.timer = setInterval(() => this.triggerRefresh(), this.refreshIntervalMs);
        this.timer.unref?.();

        // Seed immediately at deploy so today's already-accrued shares are captured
        // before the retention window has a chance to drop any of them.
        setTimeout(() => this.triggerRefresh(), this.initialSeedDelayMs).unref?.();
    }

    public async onModuleDestroy(): Promise<void> {
        if (this.timer != null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.activeRefresh != null) {
            await this.activeRefresh;
        }
    }

    private triggerRefresh(): void {
        if (this.activeRefresh != null) {
            return;
        }

        this.activeRefresh = this.refreshStrikes()
            .catch(error => {
                console.error(`Nonce strike refresh failed: ${error.message}`);
                return { processed: false, capturedRows: 0 };
            })
            .finally(() => {
                this.activeRefresh = null;
            });
    }

    public async refreshStrikes(): Promise<NonceStrikeRefreshResult> {
        return this.dataSource.transaction(async manager => {
            const [lockRow] = await manager.query(`
                SELECT pg_try_advisory_xact_lock($1::bigint) AS "locked"
            `, [NONCE_STRIKE_ADVISORY_LOCK]);

            if (lockRow?.locked !== true) {
                return { processed: false, reason: 'locked', capturedRows: 0 };
            }

            const candidates = await this.loadCandidates(manager);

            let capturedRows = 0;
            for (const candidate of candidates) {
                capturedRows += await this.insertStrike(manager, candidate);
            }

            await this.trimToKeepCount(manager);

            if (capturedRows > 0) {
                console.log(`Nonce strike refresh captured ${capturedRows} new record(s)`);
            }

            return { processed: true, capturedRows };
        });
    }

    private async loadCandidates(manager: EntityManager): Promise<StrikeCandidate[]> {
        return manager.query(`
            SELECT
                "nonce",
                "submissionDifficulty"::text AS "submissionDifficulty",
                "acceptedAt",
                "blockHeight"::text AS "blockHeight",
                "isBlockCandidate",
                "blockSubmissionResult",
                "address",
                "clientName"
            FROM "accepted_share_entity"
            ORDER BY "accepted_share_entity"."submissionDifficulty" DESC, "accepted_share_entity"."acceptedAt" DESC
            LIMIT $1
        `, [this.keepCount]);
    }

    private async insertStrike(manager: EntityManager, candidate: StrikeCandidate): Promise<number> {
        const rows = await manager.query(`
            INSERT INTO "nonce_strike" (
                "nonce",
                "submissionDifficulty",
                "acceptedAt",
                "blockHeight",
                "isBlockCandidate",
                "blockSubmissionResult",
                "address",
                "clientName"
            ) VALUES (
                $1, $2::numeric, $3::timestamptz, $4::bigint, $5, $6, $7, $8
            )
            ON CONFLICT ("acceptedAt", "nonce") DO NOTHING
            RETURNING 1
        `, [
            candidate.nonce,
            candidate.submissionDifficulty,
            candidate.acceptedAt,
            candidate.blockHeight,
            candidate.isBlockCandidate,
            candidate.blockSubmissionResult,
            candidate.address,
            candidate.clientName,
        ]);

        return rows.length;
    }

    private async trimToKeepCount(manager: EntityManager): Promise<void> {
        await manager.query(`
            DELETE FROM "nonce_strike"
            WHERE "id" IN (
                SELECT "id" FROM "nonce_strike"
                ORDER BY "submissionDifficulty" DESC, "acceptedAt" DESC
                OFFSET $1
            )
        `, [this.keepCount]);
    }

    private readPositiveInt(name: string, defaultValue: number): number {
        const value = Number(process.env[name]);
        return Number.isInteger(value) && value > 0 ? value : defaultValue;
    }
}
