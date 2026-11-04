import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

export class CreateProductDto {
  @IsString()
  @Length(1, 64)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  productId!: string;

  @IsString()
  @Length(1, 255)
  @Matches(/\S/)
  productName!: string;

  @IsString()
  @Matches(/^(0|[1-9]\d{0,14})(\.\d{1,4})?$/)
  unitPrice!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}