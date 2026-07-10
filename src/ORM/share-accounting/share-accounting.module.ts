import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AcceptedShareEntity } from '../accepted-share/accepted-share.entity';
import { NonceDistributionService } from './nonce-distribution.service';
import { NonceStrikeMaintenanceService } from './nonce-strike-maintenance.service';
import { ShareAccountingService } from './share-accounting.service';
import { ShareHighScoreService } from './share-high-score.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([AcceptedShareEntity])],
    providers: [ShareAccountingService, ShareHighScoreService, NonceDistributionService, NonceStrikeMaintenanceService],
    exports: [TypeOrmModule, ShareAccountingService, ShareHighScoreService, NonceDistributionService, NonceStrikeMaintenanceService],
})
export class ShareAccountingModule { }
