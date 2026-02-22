import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
    VTokenExchangeRate,
    FarmingPoolSnapshot,
    ApySnapshot,
    TokenPrice,
} from '../../entities';
import { ApyCalculatorService } from './apy-calculator.service';
import { ApyController } from './apy.controller';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            VTokenExchangeRate,
            FarmingPoolSnapshot,
            ApySnapshot,
            TokenPrice,
        ]),
    ],
    controllers: [ApyController],
    providers: [ApyCalculatorService],
    exports: [ApyCalculatorService],
})
export class ApyModule { }
