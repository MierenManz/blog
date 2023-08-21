---
title: VarInt Decoding is slow! 🐢
description: Let's make it 48x faster! 🚀
index: 1
hide_navbar: true
---

# Let's make it 48x faster! 🚀

These days LEB128 VarInts are used everywhere. From V8, WebAssembly, protobufs
and more. They're used in almost every binary format that wants to make integers
as small as possible without losing data. Almost every language has some
decoding / encoding package or module for it. Today we're going to look at the
implementation of Deno's STD library and how we can use V8 and javascript quirks
to make the algorithm 48x faster than Deno's STD library implementation

## What is a VarInt

A varint is a <b><i>var</i></b>iable <b><i>int</i></b>eger. Its size is between
1-5 bytes for a 32-bit integer or 1-10 bytes for a 64-bit integer. This variable
size means that smaller numbers can be stored more efficiently. A good usecase
for them are in things like protobufs or WebAssembly binaries, where smaller
numbers are common.

You may ask yourself now "how do you know how big a varint is?" That is done by
using 7-bits out of 8-bits of every byte as a value and reserving the last bit
(`0x80` in hex) as a flag to indicate whether the next byte should also be
decoded as part of the integer value.

## Why is decoding slow in JavaScript?

It is actually not. Decoding 32-bit integers is actually quite fast in
JavaScript. This is because bitwise operations on a `number` are usually done as
machine code instructions on a 32-bit number internally. The problem comes from
the 64-bit numbers which cannot be done with a `number` but have to be done with
a `BigInt`. `BigInt` is really handy for when you need integers of a arbitrary
precision like `420 ** 69`. But now the problem is not with storing values
bigger than 32-bits. But with the fact that operations on a `BigInt` are really
really slow.

This is Deno's standard library function for decoding a 64-bit varint:

```ts
export const MaxUInt64 = 18446744073709551615n;
export const MaxVarIntLen64 = 10;
export const MaxVarIntLen32 = 5;

const MSB = 0x80;
const REST = 0x7f;
const SHIFT = 7;
const MSBN = 0x80n;
const SHIFTN = 7n;

export function decode(buf: Uint8Array, offset = 0): [bigint, number] {
  for (
    let i = offset,
      len = Math.min(buf.length, offset + MaxVarIntLen64),
      shift = 0,
      decoded = 0n;
    i < len;
    i += 1, shift += SHIFT
  ) {
    const byte = buf[i];
    decoded += BigInt((byte & REST) * Math.pow(2, shift));
    if (!(byte & MSB) && decoded > MaxUInt64) {
      throw new RangeError("overflow varint");
    }
    if (!(byte & MSB)) return [decoded, i + 1];
  }
  throw new RangeError("malformed or overflow varint");
}
```

It's not too bad when it comes to performance. It takes about 1.4µs per
iteration (on my machine) but there have been faster implementations of the same
algorithm:

```ts
export function bigintDecode(
  buffer: Uint8Array,
): [bigint, number] {
  let value = 0n;
  let length = 0;
  let i = 0;
  while (true) {
    const currentByte = BigInt(buffer[i]);
    value |= (currentByte & 0x7Fn) << BigInt(length);
    length += 7;
    i++;
    if (i > 10) throw new Error("Max Length Reached");

    if ((currentByte & 0x80n) !== 0x80n) break;
  }

  return [value, i];
}
```

This algorithm is already a lot faster. It takes about 580ns (0.58µs) per
iteration which is more than double the performance but still nowhere near the
48x increase mentioned above

## Let's use WebAssembly!

After not finding a faster way of decoding varints in JavaScript I started to
think "what about WebAssembly? That has 64-bit integers." And so I started
learning about WebAssembly text. It's the 1 to 1 text equivalent of a
WebAssembly binary. Kinda like how asm is that for machine code.

```wat
(module
  (memory (export "memory") 1)
  (func $read
    (export "read")
    (param $ptr i32)
    (result i64 i32)
    (local $v i64)
    (local $length i64)
    (local $temp i64)

    (block $B0
      (loop $L0
        ;; CurrentByte
        local.get $ptr
        i64.load8_u
        local.tee $temp
        i64.const 127
        i64.and

        ;; << 7 * length
        local.get $length
        i64.shl
        ;; value |= i64.shl
        local.get $v
        i64.or
        local.set $v

        ;; length++;
        local.get $length
        i64.const 7
        i64.add
        local.tee $length

        ;; CurrentByte
        local.get $temp
        i64.const 128
        i64.and
        i64.eqz
        br_if $B0

        ;; Move to next iteration
        local.get $ptr
        i32.const 1
        i32.add
        local.set $ptr

        ;; Branch if not over 70
        i64.const 70
        i64.lt_u
        br_if $L0
      )
      unreachable
    )

    local.get $v
    local.get $length
    i64.const 7
    i64.div_u
    i32.wrap_i64
  )
)
```

This code is quite complex to understand but it's the same algorithm as the
TypeScript code in the last section. After benchmarking we can see this takes
about 168ns (0.168us) per iteration. That is already coming in quite good.
Overall a 8x performance improvement. But why is it nowhere near the 48x? This
is due to the fact that WebAssembly and JavaScript have a bit of overhead when
calling into the other language. This is because of the data we copy and pass to
WASM and because V8 (and most other engines) don't do call inlining near the
language boundary. While it can do that with JS<=>JS calls and WASM<=>WASM calls

## New "Algorithm"

After a 2 weeks of summercamp and thinking for a long while I came up with a
idea. What if I use JavaScript but not a `BigInt` 🤔 This might sound weird cuz
earlier I've said that 32-bits are not enough for 64-bit numbers. But what if we
just use two 32-bit integers and then cast it to a `BigInt`. And in a hour I
created my initial implementation as seen below.

```ts
export function jsDecodeV1(input: Uint8Array): bigint {
  const ab = new ArrayBuffer(8);
  const u32View = new Uint32Array(ab);
  const u64View = new BigUint64Array(ab);

  let intermediate = 0;
  let position = 0;

  for (let i = 0; i < input.length; i++) {
    if (i === 11) throw new Error("Maximum size reached");

    const byte = input[i];

    // 1. Take the lower 7 bits of the byte.
    // 2. Shift the bits into the correct position.
    // 3. Bitwise OR it with the intermediate value
    // QUIRK: in the 5th (and 10th) iteration of this loop it will overflow on the shift.
    // This causes only the lower 4 bits to be shifted into place and removing the upper 3 bits
    intermediate |= (byte & 0x7F) << position;

    // if the intermediate value is full. Write it to the view
    // Else just add 7 to the position
    if (position === 28) {
      // Write to the view
      u32View[0] = intermediate;
      // set `intermediate` to the remaining 3 bits
      // We only want the remaining three bits because the other 4 have been "consumed" on line 21
      intermediate = (byte >>> 3) & 0x07;
      // set `positon` to 3 because we have written 3 bits
      position = 3;
    } else {
      position += 7;
    }

    // if no continuation bit.
    // then write the intermediate value to the empty "slot"
    if ((byte & 0x80) !== 0x80) {
      // if the first slot is taken. Take the second slot
      u32View[Number(i > 3)] = intermediate;
      break;
    }
  }

  // Cast the two u32's to a u64 bigint
  return u64View[0];
}
```

It fully works as expected but it's 1.5x slower than the standard library's
implementation. If bitwise operations are faster on `number` than on `BigInt`.
Then why is this algorithm slower?

## Lets Dig Deeper

Why is our algorithm slower? After trying some things and looking at some basic
optimization I found a few things that were causing the code to be slower than
expected.

### Allocations

At the beginning of the code we see 3 lines of code.

```ts
const ab = new ArrayBuffer(8);
const u32View = new Uint32Array(ab);
const u64View = new BigUint64Array(ab);
```

These 3 lines allocate a small buffer that we use to cast the 2 u32's into a
`BigInt`. What if we move that allocation to the global scope. in our case, we
don't need separate buffers per call, so we can hoist the allocation.

```diff
- export function jsDecodeV1(input: Uint8Array): bigint {
-   const ab = new ArrayBuffer(8);
-   const u32View = new Uint32Array(ab);
-   const u64View = new BigUint64Array(ab);

+ const AB = new ArrayBuffer(8);
+ const U32_VIEW = new Uint32Array(AB);
+ const U64_VIEW = new BigUint64Array(AB);
+ export function jsDecodeV2(input: Uint8Array): bigint {
+   U64_VIEW[0] = 0n;


-       u32View[0] = intermediate;
+       U32_VIEW[0] = intermediate;


-       u32View[Number(i > 3)] = intermediate;
+       U32_VIEW[Number(i > 3)] = intermediate;


-   return u64View[0];
+   return U64_VIEW[0];
```

```ts
const AB = new ArrayBuffer(8);
const U32_VIEW = new Uint32Array(AB);
const U64_VIEW = new BigUint64Array(AB);

export function jsDecodeV2(input: Uint8Array): bigint {
  U64_VIEW[0] = 0n;
  let intermediate = 0;
  let position = 0;

  for (let i = 0; i < input.length; i++) {
    if (i === 11) throw new Error("Maximum size reached");

    const byte = input[i];

    // 1. Take the lower 7 bits of the byte.
    // 2. Shift the bits into the correct position.
    // 3. Bitwise OR it with the intermediate value
    // QUIRK: in the 5th (and 10th) iteration of this loop it will overflow on the shift.
    // This causes only the lower 4 bits to be shifted into place and removing the upper 3 bits
    intermediate |= (byte & 0x7F) << position;

    // if the intermediate value is full. Write it to the view
    // Else just add 7 to the position
    if (position === 28) {
      // Write to the view
      U32_VIEW[0] = intermediate;
      // set `intermediate` to the remaining 3 bits
      // We only want the remaining three bits because the other 4 have been "consumed" on line 21
      intermediate = (byte >>> 3) & 0x07;
      // set `positon` to 3 because we have written 3 bits
      position = 3;
    } else {
      position += 7;
    }

    // if no continuation bit.
    // then write the intermediate value to the empty "slot"
    if ((byte & 0x80) !== 0x80) {
      // if the first slot is taken. Take the second slot
      U32_VIEW[Number(i > 3)] = intermediate;
      break;
    }
  }

  // Cast the two u32's to a u64 bigint
  return U64_VIEW[0];
}
```

After changing the code a little we see major performance gains. Going from 1.5x
slower than Deno's std implementation to going 35ns per iterations! We're
already nearly there in terms of performance. But what else can we do?

### Property Access

Another bit of optimizations comes from property access. The whole time we were
accessing the array's `.length` property. Which in theory won't change for us
because we are not mutating the array. Sadly enough the compiler cannot
guarantee that that is not the case so each time it will access the property and
check it's value. A simple `const length = input.length` just before the loop
let's the compiler access the property once and then guarantee that it won't
need to loop more than `length` even if `input` is mutated. This small
optimization also gives us another 3.8ns per iteration. Getting us to 31ns per
iteration

```diff
- export function jsDecodeV2(input: Uint8Array): bigint {
+ export function jsDecodeV3(input: Uint8Array): bigint {


-   for (let i = 0; i < input.length; i++) {
+   const length = input.length;
+
+   for (let i = 0; i < length; i++) {
```

```ts
const AB = new ArrayBuffer(8);
const U32_VIEW = new Uint32Array(AB);
const U64_VIEW = new BigUint64Array(AB);

export function jsDecodeV3(input: Uint8Array): bigint {
  U64_VIEW[0] = 0n;
  let intermediate = 0;
  let position = 0;
  const length = input.length;

  for (let i = 0; i < length; i++) {
    if (i === 11) throw new Error("Maximum size reached");

    const byte = input[i];

    // 1. Take the lower 7 bits of the byte.
    // 2. Shift the bits into the correct position.
    // 3. Bitwise OR it with the intermediate value
    // QUIRK: in the 5th (and 10th) iteration of this loop it will overflow on the shift.
    // This causes only the lower 4 bits to be shifted into place and removing the upper 3 bits

    intermediate |= (byte & 0x7F) << position;

    // if the intermediate value is full. Write it to the view
    // Else just add 7 to the position
    if (position === 28) {
      // Write to the view
      U32_VIEW[0] = intermediate;
      // set `intermediate` to the remaining 3 bits
      // We only want the remaining three bits because the other 4 have been "consumed" on line 21
      intermediate = (byte >>> 3) & 0x07;
      // set `positon` to 3 because we have written 3 bits
      position = 3;
    } else {
      position += 7;
    }

    // if no continuation bit.
    // then write the intermediate value to the empty "slot"
    if ((byte & 0x80) !== 0x80) {
      // if the first slot is taken. Take the second slot
      U32_VIEW[Number(i > 3)] = intermediate;
      break;
    }
  }

  // Cast the two u32's to a u64 bigint
  return U64_VIEW[0];
}
```

### Branch elimination

Currently we got a nasty `if else` in our code. The `if` branch if really
important. But is there anything we can do about the `else`? YES! We can do
something about it. What if we change it so that we unconditionally add 7 to
`position`.

```diff
5c5
- export function jsDecodeV3(input: Uint8Array): bigint {
+ export function jsDecodeV4(input: Uint8Array): bigint {


-     // if the intermediate value is full. Write it to the view
-     // Else just add 7 to the position
+     // If the intermediate value is full. Write it to the view


-       // set `positon` to 3 because we have written 3 bits
-       position = 3;
-     } else {
-       position += 7;

+       // set `position` to -4 because later 7 will be added, making it 3
+       position = -4;
+ 
+     position += 7;
```

```ts
const AB = new ArrayBuffer(8);
const U32_VIEW = new Uint32Array(AB);
const U64_VIEW = new BigUint64Array(AB);

export function jsDecodeV4(input: Uint8Array): bigint {
  U64_VIEW[0] = 0n;
  let intermediate = 0;
  let position = 0;
  const length = input.length;

  for (let i = 0; i < length; i++) {
    if (i === 11) throw new Error("Maximum size reached");

    const byte = input[i];

    // 1. Take the lower 7 bits of the byte.
    // 2. Shift the bits into the correct position.
    // 3. Bitwise OR it with the intermediate value
    // QUIRK: in the 5th (and 10th) iteration of this loop it will overflow on the shift.
    // This causes only the lower 4 bits to be shifted into place and removing the upper 3 bits
    intermediate |= (byte & 0x7F) << position;

    // If the intermediate value is full. Write it to the view
    if (position === 28) {
      // Write to the view
      U32_VIEW[0] = intermediate;
      // set `intermediate` to the remaining 3 bits
      // We only want the remaining three bits because the other 4 have been "consumed" on line 21
      intermediate = (byte >>> 3) & 0x07;
      // set `position` to -4 because later 7 will be added, making it 3
      position = -4;
    }

    position += 7;

    // if no continuation bit.
    // then write the intermediate value to the empty "slot"
    if ((byte & 0x80) !== 0x80) {
      // if the first slot is taken. Take the second slot
      U32_VIEW[Number(i > 3)] = intermediate;
      break;
    }
  }

  // Cast the two u32's to a u64 bigint
  return U64_VIEW[0];
}
```

We eliminated one more branch call which saved us another 2 ns per iteration.
Which get's us from 31ns down to 28ns.

## Benchmark

![Benchmark Results](../../varint_decode/bench_result.png) The benchmark code
can be found on [Github](https://github.com/mierenmanz/varint_bench)

## Summary

In conclusion it's possible to make this decoding algoritm super fast in
javascript. This it did require a lot of specific knowledge about V8, Writing
code that a JIT compiler can easily optimize and figuring out the most efficient
way of using your given constraints and resources.
