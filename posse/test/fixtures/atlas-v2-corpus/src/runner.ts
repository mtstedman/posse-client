import { Greeter } from "./greeter.js";

export function run(name: string): string {
  const g = new Greeter(name);
  return g.hello();
}
