(module
  ;; 1页内存 (64KB)
  (memory (export "memory") 1)

  ;; data段: 预置字符串 "Hello, World!"
  (data (i32.const 0) "Hello, World!\00")

  ;; 计算字符串长度 (null-terminated)
  (func $strlen (param $ptr i32) (result i32)
    (local $len i32)

    i32.const 0
    local.set $len

    block $exit
      loop $loop
        local.get $ptr
        local.get $len
        i32.add
        i32.load8_u
        i32.eqz
        br_if $exit

        local.get $len
        i32.const 1
        i32.add
        local.set $len

        br $loop
      end
    end

    local.get $len)

  ;; 将字符串中的小写字母转换为大写
  (func $to_upper (param $ptr i32) (param $len i32)
    (local $i i32)
    (local $c i32)

    i32.const 0
    local.set $i

    block $exit
      loop $loop
        local.get $i
        local.get $len
        i32.ge_u
        br_if $exit

        local.get $ptr
        local.get $i
        i32.add
        i32.load8_u
        local.set $c

        local.get $c
        i32.const 97
        i32.ge_u

        local.get $c
        i32.const 122
        i32.le_u

        i32.and
        if
          local.get $ptr
          local.get $i
          i32.add

          local.get $c
          i32.const 32
          i32.sub

          i32.store8
        end

        local.get $i
        i32.const 1
        i32.add
        local.set $i

        br $loop
      end
    end)

  ;; 两个字符串比较 (相等返回0, 不等返回非0)
  (func $strcmp (param $ptr1 i32) (param $ptr2 i32) (param $len i32) (result i32)
    (local $i i32)
    (local $diff i32)

    i32.const 0
    local.set $i

    i32.const 0
    local.set $diff

    block $exit
      loop $loop
        local.get $i
        local.get $len
        i32.ge_u
        br_if $exit

        local.get $ptr1
        local.get $i
        i32.add
        i32.load8_u

        local.get $ptr2
        local.get $i
        i32.add
        i32.load8_u

        i32.sub
        local.tee $diff
        i32.eqz
        i32.eqz
        br_if $exit

        local.get $i
        i32.const 1
        i32.add
        local.set $i

        br $loop
      end
    end

    local.get $diff)

  (export "strlen" (func $strlen))
  (export "to_upper" (func $to_upper))
  (export "strcmp" (func $strcmp))
)
