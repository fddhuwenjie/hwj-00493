(module
  ;; 阶乘函数: factorial(n) = n! 使用循环实现
  (func $factorial (param $n i32) (result i32)
    (local $result i32)
    (local $i i32)

    i32.const 1
    local.set $result

    i32.const 1
    local.set $i

    block $exit
      loop $loop
        local.get $i
        local.get $n
        i32.gt_u
        br_if $exit

        local.get $result
        local.get $i
        i32.mul
        local.set $result

        local.get $i
        i32.const 1
        i32.add
        local.set $i

        br $loop
      end
    end

    local.get $result)

  ;; 斐波那契数列: fib(n)
  (func $fib (param $n i32) (result i32)
    (local $a i32)
    (local $b i32)
    (local $i i32)
    (local $temp i32)

    i32.const 0
    local.set $a

    i32.const 1
    local.set $b

    i32.const 0
    local.set $i

    block $exit
      loop $loop
        local.get $i
        local.get $n
        i32.ge_u
        br_if $exit

        local.get $a
        local.get $b
        i32.add
        local.set $temp

        local.get $b
        local.set $a

        local.get $temp
        local.set $b

        local.get $i
        i32.const 1
        i32.add
        local.set $i

        br $loop
      end
    end

    local.get $a)

  (export "factorial" (func $factorial))
  (export "fib" (func $fib))
)
