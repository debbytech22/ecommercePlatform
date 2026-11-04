export class UnprocessableSagaEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnprocessableSagaEventError';
  }
}
