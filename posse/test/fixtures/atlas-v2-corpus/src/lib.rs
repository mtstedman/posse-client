use std::fmt::Display;

pub trait Greeting {
    fn hello(&self) -> String;
}

pub struct Greeter {
    pub name: String,
}

impl Greeting for Greeter {
    fn hello(&self) -> String {
        format!("Hello, {}!", self.name)
    }
}

pub const ANSWER: u32 = 42;
