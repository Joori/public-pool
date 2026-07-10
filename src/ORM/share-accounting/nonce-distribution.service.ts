import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

const NONCE_BUCKET_COUNT = 256;

export interface NonceBucket {
    bucket: number;
    shareCount: number;
    maxDifficulty: number | null;
    blockCandidateCount: number;
}

export interface NonceStrike {
    nonce: string;
    submissionDifficulty: number;
    acceptedAt: Date;
    blockHeight: number | null;
    isBlockCandidate: boolean;
    blockSubmissionResult: string | null;
    address: string | null;
    clientName: string | null;
}

export interface NonceDistributionResponse {
    range: { from: string | null; to: string | null };
    totalShareCount: number;
    buckets: NonceBucket[];
    strikes: NonceStrike[];
}

interface RawBucketRow {
    nonceBucket: number;
    shareCount: string;
    maxDifficulty: string | null;
    blockCandidateCount: string;
}

interface RawStrikeRow {
    nonce: string;
    submissionDifficulty: string;
    acceptedAt: Date;
    blockHeight: string | null;
    isBlockCandidate: boolean;
    blockSubmissionResult: string | null;
    address: string | null;
    clientName: string | null;
}

@Injectable()
export class NonceDistributionService {

    private readonly cacheTtlMs = this.readPositiveInt('NONCE_DISTRIBUTION_CACHE_TTL_MS', 30_000);
    private readonly strikeLimit = this.readPositiveInt('NONCE_DISTRIBUTION_STRIKE_LIMIT', 20);

    // Only the default (no time range) query is cached, since that's the hot path for
    // the initial dashboard load; range-scrubbed queries always hit the continuous
    // aggregate directly, which is cheap by design and doesn't warrant unbounded cache growth.
    private cachedDefault: NonceDistributionResponse | null = null;
    private cachedDefaultAt = 0;

    constructor(private readonly dataSource: DataSource) { }

    public async getDistribution(from?: Date, to?: Date): Promise<NonceDistributionResponse> {
        const isDefaultRange = from == null && to == null;
        const now = Date.now();

        if (isDefaultRange && this.cachedDefault != null && (now - this.cachedDefaultAt) < this.cacheTtlMs) {
            return this.cachedDefault;
        }

        const [buckets, totalShareCount] = await this.loadBuckets(from, to);
        const strikes = await this.loadStrikes();

        const response: NonceDistributionResponse = {
            range: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
            totalShareCount,
            buckets,
            strikes,
        };

        if (isDefaultRange) {
            this.cachedDefault = response;
            this.cachedDefaultAt = now;
        }

        return response;
    }

    private async loadBuckets(from?: Date, to?: Date): Promise<[NonceBucket[], number]> {
        const params: unknown[] = [];
        const filters: string[] = [];

        if (from != null) {
            filters.push(`"bucketTime" >= $${params.push(from)}`);
        }
        if (to != null) {
            filters.push(`"bucketTime" < $${params.push(to)}`);
        }

        const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

        const rows: RawBucketRow[] = await this.dataSource.query(`
            SELECT
                "nonceBucket",
                SUM("shareCount")::text AS "shareCount",
                MAX("maxDifficulty")::text AS "maxDifficulty",
                SUM("blockCandidateCount")::text AS "blockCandidateCount"
            FROM "nonce_distribution_hourly"
            ${whereClause}
            GROUP BY "nonceBucket"
        `, params);

        return [this.fillBuckets(rows), this.sumShareCount(rows)];
    }

    // Exported shape logic kept pure/synchronous so it's unit-testable without a DB.
    public fillBuckets(rows: RawBucketRow[]): NonceBucket[] {
        const byBucket = new Map<number, RawBucketRow>();
        for (const row of rows) {
            byBucket.set(Number(row.nonceBucket), row);
        }

        const buckets: NonceBucket[] = [];
        for (let bucket = 0; bucket < NONCE_BUCKET_COUNT; bucket++) {
            const row = byBucket.get(bucket);
            buckets.push({
                bucket,
                shareCount: row != null ? Number(row.shareCount) : 0,
                maxDifficulty: row?.maxDifficulty != null ? Number(row.maxDifficulty) : null,
                blockCandidateCount: row != null ? Number(row.blockCandidateCount) : 0,
            });
        }

        return buckets;
    }

    private sumShareCount(rows: RawBucketRow[]): number {
        return rows.reduce((sum, row) => sum + Number(row.shareCount), 0);
    }

    private async loadStrikes(): Promise<NonceStrike[]> {
        const rows: RawStrikeRow[] = await this.dataSource.query(`
            SELECT
                "nonce",
                "submissionDifficulty"::text AS "submissionDifficulty",
                "acceptedAt",
                "blockHeight"::text AS "blockHeight",
                "isBlockCandidate",
                "blockSubmissionResult",
                "address",
                "clientName"
            FROM "nonce_strike"
            ORDER BY "nonce_strike"."submissionDifficulty" DESC, "nonce_strike"."acceptedAt" DESC
            LIMIT $1
        `, [this.strikeLimit]);

        return rows.map(row => ({
            nonce: row.nonce,
            submissionDifficulty: Number(row.submissionDifficulty),
            acceptedAt: row.acceptedAt,
            blockHeight: row.blockHeight != null ? Number(row.blockHeight) : null,
            isBlockCandidate: row.isBlockCandidate,
            blockSubmissionResult: row.blockSubmissionResult,
            address: row.address,
            clientName: row.clientName,
        }));
    }

    private readPositiveInt(name: string, defaultValue: number): number {
        const value = Number(process.env[name]);
        return Number.isInteger(value) && value > 0 ? value : defaultValue;
    }
}
