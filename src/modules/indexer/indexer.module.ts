import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
    IndexerCheckpoint,
    VTokenExchangeRate,
    FarmingPoolSnapshot,
} from '../../entities';
import { BifrostRpcService } from './bifrost-rpc.service';
import { IndexerService } from './indexer.service';
import { IndexerController } from './indexer.controller';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            IndexerCheckpoint,
            VTokenExchangeRate,
            FarmingPoolSnapshot,
        ]),
    ],
    controllers: [IndexerController],
    providers: [BifrostRpcService, IndexerService],
    exports: [BifrostRpcService, IndexerService],
})
export class IndexerModule { }
