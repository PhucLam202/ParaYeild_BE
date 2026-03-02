import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SimulationService } from './simulation.service';
import { SimulationController, PoolsController } from './simulation.controller';
import { PoolsClientService } from '../../common/services/pools-client.service';

@Module({
    imports: [ConfigModule],
    controllers: [SimulationController, PoolsController],
    providers: [SimulationService, PoolsClientService],
    exports: [SimulationService],
})
export class SimulationModule { }
