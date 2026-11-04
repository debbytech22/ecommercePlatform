import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { ProductEntity } from './product.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class CatalogService {
  constructor(
    @InjectRepository(ProductEntity)
    private readonly products: Repository<ProductEntity>,
  ) {}

  async create(dto: CreateProductDto): Promise<ProductEntity> {
    const existing = await this.products.findOne({
      where: { productId: dto.productId },
    });

    if (existing) {
      throw new ConflictException('Product ID already exists');
    }

    const product = this.products.create({
      ...dto,
      active: dto.active ?? true,
    });

    try {
      return await this.products.save(product);
    } catch (error) {
      // The database unique index also protects concurrent creation.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ER_DUP_ENTRY'
      ) {
        throw new ConflictException('Product ID already exists');
      }

      throw error;
    }
  }

  async update(
    productId: string,
    dto: UpdateProductDto,
  ): Promise<ProductEntity> {
    const product = await this.products.findOne({
      where: { productId },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    Object.assign(product, dto);

    return this.products.save(product);
  }

  async getPrices(productIds: string[]) {
    const uniqueIds = [...new Set(productIds)];

    const products = await this.products.find({
      where: {
        productId: In(uniqueIds),
      },
    });

    return {
      items: products.map((product) => ({
        productId: product.productId,
        productName: product.productName,
        unitPrice: product.unitPrice,
        currency: product.currency,
        active: product.active,
      })),
    };
  }
}