package main

import (
	"fmt"
	"os"
	"time"
)

func calculate(base int) int {
	bonus := 7
	total := base + bonus // breakpoint: calculate
	return total // breakpoint: return
}

func main() {
	base := 35
	result := calculate(base) // breakpoint: call
	fmt.Println("result:", result) // breakpoint: output
	if len(os.Args) > 1 && os.Args[1] == "wait" {
		for {
			time.Sleep(10 * time.Millisecond)
		}
	}
}
