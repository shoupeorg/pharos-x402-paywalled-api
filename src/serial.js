export class SerialExecutor {
  constructor() { this.tail = Promise.resolve(); }

  run(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
