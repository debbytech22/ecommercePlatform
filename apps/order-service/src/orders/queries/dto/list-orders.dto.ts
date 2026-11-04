import { OrderStatus } from '../../../entities/order.entity';

export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;

export interface ListOrdersDto {
  customerId: string;
  page: number;
  limit: number;
  status: OrderStatus | null;
}
