import { ConflictException } from '@nestjs/common';
import { SagaState } from './enums/saga-state.enum';
import { canTransitionSaga } from './saga-state-machine';

export class SagaTransitionValidator {
  static assertAllowed(current: SagaState, next: SagaState): void {
    if (!canTransitionSaga(current, next)) {
      throw new ConflictException(
        `Saga transition from ${current} to ${next} is not allowed`,
      );
    }
  }
}
