import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @Length(1, 255)
  productName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(0|[1-9]\d{0,14})(\.\d{1,4})?$/)
  unitPrice?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}