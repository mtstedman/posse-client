package main

import (
	"fmt"
)

type Greeter struct {
	Name string
}

func (g *Greeter) Hello() string {
	return fmt.Sprintf("Hello, %s!", g.Name)
}

func main() {
	g := &Greeter{Name: "world"}
	fmt.Println(g.Hello())
}
