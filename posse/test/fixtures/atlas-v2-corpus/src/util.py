from typing import List

CONSTANT = 42


class Logger:
    def __init__(self, name: str):
        self.name = name

    def log(self, msg: str) -> None:
        print(f"[{self.name}] {msg}")


def standalone(x: int) -> int:
    return x + 1
