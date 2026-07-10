import { DataSource, EntityManager } from 'typeorm';

import { NonceStrikeMaintenanceService } from './nonce-strike-maintenance.service';

describe('NonceStrikeMaintenanceService', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let manager: { query: jest.Mock };
    let dataSource: { transaction: jest.Mock };
    let service: NonceStrikeMaintenanceService;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.NONCE_STRIKE_KEEP_COUNT = '50';
        manager = { query: jest.fn() };
        dataSource = {
            transaction: jest.fn(async callback => callback(manager as unknown as EntityManager)),
        };
        service = new NonceStrikeMaintenanceService(dataSource as unknown as DataSource);
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.useRealTimers();
    });

    it('does nothing on init outside the master process', () => {
        process.env.MASTER = 'false';
        service.onModuleInit();
        expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('does nothing on init for API-only processes even if MASTER is set', () => {
        process.env.MASTER = 'true';
        process.env.API_ONLY = 'true';
        service.onModuleInit();
        expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('skips the refresh when the advisory lock is already held', async () => {
        manager.query.mockResolvedValueOnce([{ locked: false }]);

        const result = await service.refreshStrikes();

        expect(result).toEqual({ processed: false, reason: 'locked', capturedRows: 0 });
        expect(manager.query).toHaveBeenCalledTimes(1);
    });

    it('inserts new candidates, skips conflicts, and trims to keepCount', async () => {
        manager.query
            .mockResolvedValueOnce([{ locked: true }]) // advisory lock
            .mockResolvedValueOnce([
                {
                    nonce: '4eb71e54',
                    submissionDifficulty: '1500000',
                    acceptedAt: new Date('2026-07-10T07:55:08.355Z'),
                    blockHeight: '957272',
                    isBlockCandidate: false,
                    blockSubmissionResult: null,
                    address: 'bc1qexample',
                    clientName: 'NerdQAxe++',
                },
                {
                    nonce: 'be3514ce',
                    submissionDifficulty: '900000',
                    acceptedAt: new Date('2026-07-09T00:00:00Z'),
                    blockHeight: '957200',
                    isBlockCandidate: false,
                    blockSubmissionResult: null,
                    address: 'bc1qexample',
                    clientName: 'NerdQAxe++',
                },
            ]) // candidates
            .mockResolvedValueOnce([{ 1: 1 }]) // insert #1: new row
            .mockResolvedValueOnce([]) // insert #2: conflict, already captured
            .mockResolvedValueOnce([]); // trim

        const result = await service.refreshStrikes();

        expect(result).toEqual({ processed: true, capturedRows: 1 });
        expect(manager.query).toHaveBeenCalledTimes(5);
        const trimCall = manager.query.mock.calls[4];
        expect(trimCall[0]).toContain('DELETE FROM "nonce_strike"');
        expect(trimCall[1]).toEqual([50]);
    });
});
