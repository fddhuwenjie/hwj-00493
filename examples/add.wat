(module
  ;; 简单的加法函数: add(a, b) = a + b
  (func $add (param $a i32) (param $b i32) (result i32)
    local.get $a
    local.get $b
    i32.add)

  (func $sub (param $a i32) (param $b i32) (result i32)
    local.get $a
    local.get $b
    i32.sub)

  (func $mul (param $a i32) (param $b i32) (result i32)
    local.get $a
    local.get $b
    i32.mul)

  (export "add" (func $add))
  (export "sub" (func $sub))
  (export "mul" (func $mul))
)
