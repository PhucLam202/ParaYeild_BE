import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TokenPrice } from '../../entities';
import { PriceIndexerService } from './price-indexer.service';
import { PriceIndexerController } from './price-indexer.controller';

@Module({
    imports: [TypeOrmModule.forFeature([TokenPrice])],
    controllers: [PriceIndexerController],
    providers: [PriceIndexerService],
    exports: [PriceIndexerService],
})
export class PriceIndexerModule { }
