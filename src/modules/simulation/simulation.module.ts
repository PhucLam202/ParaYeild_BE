import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SimulationService } from './simulation.service';
import { SimulationController } from './simulation.controller';
import { PoolsClientService } from '../../common/services/pools-client.service';

@Module({
    imports: [ConfigModule],
    controllers: [SimulationController],
    providers: [SimulationService, PoolsClientService],
    exports: [SimulationService],
})
export class SimulationModule { }
