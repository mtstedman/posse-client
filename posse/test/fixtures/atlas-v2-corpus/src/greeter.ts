export interface Greeting {
  hello(): string;
}

export class Base {
  protected name: string;
  constructor(name: string) {
    this.name = name;
  }
}

export class Greeter extends Base implements Greeting {
  public hello(): string {
    return `Hello, ${this.name}!`;
  }
}
