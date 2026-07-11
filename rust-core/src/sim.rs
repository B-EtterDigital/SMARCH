use std::collections::HashSet;

const KEYWORDS: &[&str] = &[
    "if",
    "else",
    "elif",
    "elseif",
    "for",
    "foreach",
    "while",
    "do",
    "switch",
    "case",
    "default",
    "break",
    "continue",
    "return",
    "goto",
    "function",
    "func",
    "def",
    "fn",
    "class",
    "struct",
    "interface",
    "enum",
    "trait",
    "impl",
    "import",
    "from",
    "export",
    "require",
    "include",
    "using",
    "namespace",
    "package",
    "module",
    "public",
    "private",
    "protected",
    "internal",
    "static",
    "final",
    "abstract",
    "const",
    "let",
    "var",
    "val",
    "new",
    "delete",
    "try",
    "catch",
    "finally",
    "throw",
    "throws",
    "raise",
    "except",
    "async",
    "await",
    "yield",
    "void",
    "this",
    "self",
    "super",
    "extends",
    "implements",
    "in",
    "of",
    "is",
    "as",
    "and",
    "or",
    "not",
    "true",
    "false",
    "null",
    "none",
    "nil",
    "undefined",
    "lambda",
    "with",
    "match",
    "when",
    "where",
    "select",
    "end",
];

fn is_word_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || c == '$'
}
fn is_word_part(c: char) -> bool {
    is_word_start(c) || c.is_ascii_digit()
}
fn is_num_part(c: char) -> bool {
    c.is_ascii_digit()
        || matches!(c, '.' | '_' | 'x' | 'X')
        || ('a'..='f').contains(&c)
        || ('A'..='F').contains(&c)
}

pub fn normalize_source(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '/' && chars.get(i + 1) == Some(&'/') {
            i += 2;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if ch == '#' {
            i += 1;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if ch == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i = (i + 2).min(chars.len());
        } else if matches!(ch, '"' | '\'' | '`') {
            let quote = ch;
            i += 1;
            while i < chars.len() && chars[i] != quote {
                if chars[i] == '\\' {
                    i += 1;
                }
                i += 1;
            }
            i = (i + 1).min(chars.len());
            out.push("str".into());
        } else if ch.is_ascii_digit()
            || (ch == '.' && chars.get(i + 1).is_some_and(|c| c.is_ascii_digit()))
        {
            i += 1;
            while i < chars.len() && is_num_part(chars[i]) {
                i += 1;
            }
            out.push("num".into());
        } else if is_word_start(ch) {
            let start = i;
            i += 1;
            while i < chars.len() && is_word_part(chars[i]) {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect::<String>().to_lowercase();
            out.push(if KEYWORDS.contains(&word.as_str()) {
                word
            } else {
                "v".into()
            });
        } else if ch.is_ascii_whitespace() {
            i += 1;
        } else {
            out.push(ch.to_string());
            i += 1;
        }
    }
    out
}

pub fn k_gram_shingles(tokens: &[String], k: usize) -> Vec<String> {
    if tokens.is_empty() {
        return Vec::new();
    }
    let k = k.max(1);
    if tokens.len() < k {
        return vec![tokens.join(" ")];
    }
    tokens.windows(k).map(|items| items.join(" ")).collect()
}

fn hash32(text: &str) -> u32 {
    text.bytes().fold(0x811c9dc5_u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(0x01000193)
    })
}

fn hash64(text: &str) -> u64 {
    text.encode_utf16()
        .fold(0xcbf29ce484222325_u64, |mut hash, code| {
            hash = (hash ^ u64::from(code & 0xff)).wrapping_mul(0x100000001b3);
            (hash ^ u64::from(code >> 8)).wrapping_mul(0x100000001b3)
        })
}

pub fn winnow(shingles: &[String], window: usize) -> HashSet<u32> {
    if shingles.is_empty() {
        return HashSet::new();
    }
    let hashes: Vec<u32> = shingles.iter().map(|item| hash32(item)).collect();
    let window = window.max(1);
    let mut out = HashSet::new();
    if hashes.len() < window {
        let index = (1..hashes.len()).fold(0, |min, index| {
            if hashes[index] <= hashes[min] {
                index
            } else {
                min
            }
        });
        out.insert(hashes[index]);
        return out;
    }
    let mut last = None;
    for start in 0..=hashes.len() - window {
        let index = (start + 1..start + window).fold(start, |min, index| {
            if hashes[index] <= hashes[min] {
                index
            } else {
                min
            }
        });
        if last != Some(index) {
            out.insert(hashes[index]);
            last = Some(index);
        }
    }
    out
}

pub fn simhash(shingles: &[String]) -> u64 {
    let mut bits = [0_i64; 64];
    for shingle in shingles {
        let hash = hash64(shingle);
        for (bit, vote) in bits.iter_mut().enumerate() {
            *vote += if hash & (1_u64 << bit) != 0 { 1 } else { -1 };
        }
    }
    bits.iter().enumerate().fold(0_u64, |value, (bit, vote)| {
        if *vote > 0 {
            value | (1_u64 << bit)
        } else {
            value
        }
    })
}

pub fn similarity(left: &str, right: &str) -> f64 {
    let left_tokens = normalize_source(left);
    let right_tokens = normalize_source(right);
    if left_tokens == right_tokens {
        return 1.0;
    }
    let left_shingles = k_gram_shingles(&left_tokens, 5);
    let right_shingles = k_gram_shingles(&right_tokens, 5);
    let left_fingerprints = winnow(&left_shingles, 4);
    let right_fingerprints = winnow(&right_shingles, 4);
    let intersection = left_fingerprints.intersection(&right_fingerprints).count();
    let union = left_fingerprints.len() + right_fingerprints.len() - intersection;
    let jaccard = if union == 0 {
        1.0
    } else {
        intersection as f64 / union as f64
    };
    let simhash_score =
        1.0 - (simhash(&left_shingles) ^ simhash(&right_shingles)).count_ones() as f64 / 64.0;
    (0.8 * jaccard + 0.2 * simhash_score).clamp(0.0, 1.0)
}

pub fn file_set_similarity(left: &[&str], right: &[&str]) -> f64 {
    if left.is_empty() && right.is_empty() {
        return 1.0;
    }
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    fn direction(source: &[&str], target: &[&str]) -> f64 {
        let mut weight_sum = 0_usize;
        let mut score_sum = 0.0;
        for text in source {
            let weight = normalize_source(text).len().max(1);
            let best = target
                .iter()
                .map(|candidate| similarity(text, candidate))
                .fold(0.0_f64, f64::max);
            score_sum += weight as f64 * best;
            weight_sum += weight;
        }
        score_sum / weight_sum as f64
    }
    (direction(left, right) + direction(right, left)) / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;

    const BIG: &str = r#"
// inventory service — computes restock plans for the warehouse
import { database } from "./db";
function computeRestock(items, threshold) {
  const plans = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.quantity < threshold) {
      const deficit = threshold - item.quantity;
      const order = { sku: item.sku, amount: deficit * 2, urgent: deficit > 10 };
      plans.push(order);
    } else if (item.quantity > threshold * 5) {
      plans.push({ sku: item.sku, amount: 0, overstocked: true });
    }
  }
  return plans.sort((a, b) => b.amount - a.amount);
}
function summarize(plans) {
  let total = 0;
  const urgent = [];
  for (const plan of plans) {
    total += plan.amount;
    if (plan.urgent) { urgent.push(plan.sku); }
  }
  return { total, urgentCount: urgent.length, urgent };
}
export { computeRestock, summarize };
"#;

    #[test]
    fn reproduces_javascript_score_table() {
        let changed = BIG.replace("amount: deficit * 2", "amount: deficit + 2");
        let reflowed = BIG
            .lines()
            .map(|line| format!("    {}", line.trim()))
            .collect::<Vec<_>>()
            .join("\n\n");
        let renamed = BIG
            .replace("items", "stockList")
            .replace("threshold", "floorLevel")
            .replace("plans", "orderPlan")
            .replace("index", "cursor")
            .replace("deficit", "shortfall")
            .replace("plan", "entry")
            .replace("computeRestock", "buildOrders")
            .replace("summarize", "rollup");
        let unrelated = r#"
    #!/usr/bin/env python
    def fibonacci(count):
        """generate the first n fibonacci numbers"""
        sequence = [0, 1]
        while len(sequence) < count:
            sequence.append(sequence[-1] + sequence[-2])
        return sequence[:count]

    class Greeter:
        def __init__(self, name):
            self.name = name
        def hello(self):
            return "hi " + self.name
  "#;
        let copy = BIG.replace("items", "goods").replace("threshold", "cap");
        let set_a = [
            BIG,
            "export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));",
        ];
        let set_b = ["def f(x):\n    return x * x + 1\n", copy.as_str()];
        let strangers = ["fn main() { println!(\"{}\", 41); }"];
        let scores = [
            (similarity(BIG, BIG), 1.0),
            (similarity(BIG, &changed), 0.925),
            (similarity(BIG, &reflowed), 1.0),
            (similarity(BIG, &renamed), 1.0),
            (similarity(BIG, unrelated), 0.113),
            (file_set_similarity(&set_a, &set_b), 0.928),
            (file_set_similarity(&set_a, &strangers), 0.109),
        ];
        for (actual, expected) in scores {
            assert!((actual - expected).abs() <= 0.01, "{actual} != {expected}");
        }
    }
}
