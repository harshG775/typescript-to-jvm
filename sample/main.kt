fun add(a: Double, b: Double): Double {
    return a + b
}

fun abs2(x: Double): Double {
    if (x < 0) return -x
    return x
}

fun sumTo(n: Double): Double {
    var s = 0.0
    var i = 1.0
    while (i <= n) {
        s = s + i
        i = i + 1
    }
    return s
}
