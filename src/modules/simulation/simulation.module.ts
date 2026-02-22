import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SimulationService } from './simulation.service';
import { SimulationController } from './simulation.controller';

@Module({
    imports: [ConfigModule],
    controllers: [SimulationController],
    providers: [SimulationService],
    exports: [SimulationService],
})
export class SimulationModule { }
