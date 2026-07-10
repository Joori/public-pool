import { DataSource } from 'typeorm';

import { NonceDistributionService } from './nonce-distribution.service';

describe('NonceDistributionService', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let dataSource: { query: jest.Mock };
    let service: NonceDistributionService;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.NONCE_DISTRIBUTION_CACHE_TTL_MS = '30000';
        process.env.NONCE_DISTRIBUTION_STRIKE_LIMIT = '20';
        dataSource = { query: jest.fn() };
        service = new NonceDistributionService(dataSource as unknown as DataSource);
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('fills all 256 buckets, zero-filling ones with no shares', () => {
        const rows = [
            { nonceBucket: 0, shareCount: '3', maxDifficulty: '12.5', blockCandidateCount: '0' },
            { nonceBucket: 255, shareCount: '7', maxDifficulty: '9.1', blockCandidateCount: '1' },
        ];

        const buckets = service.fillBuckets(rows);

        expect(buckets).toHaveLength(256);
        expect(buckets[0]).toEqual({ bucket: 0, shareCount: 3, maxDifficulty: 12.5, blockCandidateCount: 0 });
        expect(buckets[255]).toEqual({ bucket: 255, shareCount: 7, maxDifficulty: 9.1, blockCandidateCount: 1 });
        expect(buckets[1]).toEqual({ bucket: 1, shareCount: 0, maxDifficulty: null, blockCandidateCount: 0 });
        expect(buckets[128]).toEqual({ bucket: 128, shareCount: 0, maxDifficulty: null, blockCandidateCount: 0 });
    });

    it('totals share counts across buckets to match a direct row sum, dropping no rows', async () => {
        const bucketRows = [
            { nonceBucket: 3, shareCount: '10', maxDifficulty: '5', blockCandidateCount: '0' },
            { nonceBucket: 200, shareCount: '25', maxDifficulty: '8', blockCandidateCount: '1' },
        ];
        dataSource.query
            .mockResolvedValueOnce(bucketRows)
            .mockResolvedValueOnce([]);

        const result = await service.getDistribution();

        expect(result.totalShareCount).toBe(35);
        expect(result.buckets.reduce((sum, b) => sum + b.shareCount, 0)).toBe(35);
    });

    it('maps strike rows into typed strikes, converting numeric text fields', async () => {
        dataSource.query
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{
                nonce: '4eb71e54',
                submissionDifficulty: '1500000',
                acceptedAt: new Date('2026-07-10T07:55:08.355Z'),
                blockHeight: '957272',
                isBlockCandidate: false,
                blockSubmissionResult: null,
                address: 'bc1qexample',
                clientName: 'NerdQAxe++',
            }]);

        const result = await service.getDistribution();

        expect(result.strikes).toEqual([{
            nonce: '4eb71e54',
            submissionDifficulty: 1500000,
            acceptedAt: new Date('2026-07-10T07:55:08.355Z'),
            blockHeight: 957272,
            isBlockCandidate: false,
            blockSubmissionResult: null,
            address: 'bc1qexample',
            clientName: 'NerdQAxe++',
        }]);
    });

    it('caches the default (all-time) query within the TTL without re-querying', async () => {
        dataSource.query.mockResolvedValue([]);

        await service.getDistribution();
        await service.getDistribution();

        // two queries (buckets + strikes) for the first call only
        expect(dataSource.query).toHaveBeenCalledTimes(2);
    });

    it('bypasses the cache and re-queries when a time range is provided', async () => {
        dataSource.query.mockResolvedValue([]);

        await service.getDistribution(new Date('2026-07-01T00:00:00Z'), new Date('2026-07-02T00:00:00Z'));
        await service.getDistribution(new Date('2026-07-01T00:00:00Z'), new Date('2026-07-02T00:00:00Z'));

        expect(dataSource.query).toHaveBeenCalledTimes(4);
    });
});
