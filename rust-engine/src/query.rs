use serde_json::{Map, Value};

pub struct QueryEngine;

impl QueryEngine {
    pub fn new() -> Self {
        Self
    }

    /// Check if document data matches the query
    pub fn matches(&self, data: &Value, query: &Value) -> bool {
        match query {
            Value::Object(query_obj) => {
                // Check if this object contains operators
                if self.is_operator_object(query_obj) {
                    return self.evaluate_operators(data, query_obj);
                }

                // Otherwise, treat as field matching
                match data {
                    Value::Object(data_obj) => {
                        for (key, query_val) in query_obj {
                            match data_obj.get(key) {
                                Some(data_val) => {
                                    if !self.matches(data_val, query_val) {
                                        return false;
                                    }
                                }
                                None => {
                                    return false;
                                }
                            }
                        }
                        true
                    }
                    _ => false, // Query is object but data is not
                }
            }
            // Direct value comparison
            _ => data == query,
        }
    }

    fn is_operator_object(&self, obj: &Map<String, Value>) -> bool {
        obj.keys().any(|k| k.starts_with('$'))
    }

    fn evaluate_operators(&self, data: &Value, operators: &Map<String, Value>) -> bool {
        for (op, target) in operators {
            let result = match op.as_str() {
                "$eq" => data == target,
                "$ne" => data != target,
                "$gt" => self.compare(data, target, |a, b| a > b),
                "$gte" => self.compare(data, target, |a, b| a >= b),
                "$lt" => self.compare(data, target, |a, b| a < b),
                "$lte" => self.compare(data, target, |a, b| a <= b),
                "$in" => {
                    if let Value::Array(arr) = target {
                        arr.contains(data)
                    } else {
                        false
                    }
                },
                "$nin" => {
                    if let Value::Array(arr) = target {
                        !arr.contains(data)
                    } else {
                        false
                    }
                },
                _ => false, // Unknown operator
            };

            if !result {
                return false;
            }
        }
        true
    }

    fn compare<F>(&self, a: &Value, b: &Value, op: F) -> bool
    where
        F: Fn(f64, f64) -> bool,
    {
        match (a, b) {
            (Value::Number(n1), Value::Number(n2)) => {
                if let (Some(f1), Some(f2)) = (n1.as_f64(), n2.as_f64()) {
                    op(f1, f2)
                } else {
                    false
                }
            }
            // Add string comparison support if needed, currently only numbers
            _ => false,
        }
    }
}
