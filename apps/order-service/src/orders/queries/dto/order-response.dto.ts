export interface OrderItemResponseDto {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}

export interface OrderResponseDto {
  orderId: string;
  status: string;
  currency: string;
  subtotalAmount: string;
  totalAmount: string;
  items: OrderItemResponseDto[];
  createdAt: string;
  updatedAt: string;
}

export interface OrderSummaryDto {
  orderId: string;
  status: string;
  currency: string;
  totalAmount: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrderStatusDto {
  orderId: string;
  status: string;
  updatedAt: string;
}

export interface OrderTimelineEntryDto {
  fromStatus: string | null;
  toStatus: string;
  occurredAt: string;
  reason: string | null;
}

export interface OrderTimelineDto {
  orderId: string;
  currentStatus: string;
  entries: OrderTimelineEntryDto[];
}

export interface PaginatedOrdersDto {
  orders: OrderSummaryDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasNextPage: boolean;
  };
}
