import {
  Body,
  Controller,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { CatalogService } from './catalog-service.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { CatalogAdminTokenGuard } from './auth/bearer-token.guard';

@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /**
   * Product creation is an administrative operation.
   * Never expose this route to ordinary customers.
   */
  @Post('admin/v1/products')
  @UseGuards(CatalogAdminTokenGuard)
  createProduct(@Body() dto: CreateProductDto) {
    return this.catalog.create(dto);
  }

  @Patch('admin/v1/products/:productId')
  @UseGuards(CatalogAdminTokenGuard)
  updateProduct(
    @Param('productId') productId: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.catalog.update(productId, dto);
  }
}
