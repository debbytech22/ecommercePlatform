export interface ProductPrice {
  productId: string;
  productName: string;

  /**
   * Decimal string from the trusted catalog, for example "1250.0000".
   * Never convert money to JavaScript number.
   */
  unitPrice: string;

  currency: string;
  active: boolean;
}

export interface ProductPricingPort {
  getPrices(productIds: string[]): Promise<ProductPrice[]>;
}

export const PRODUCT_PRICING_PORT = Symbol('PRODUCT_PRICING_PORT');