// 跨演算法模組（hillClimb / rwdMap / skeleton / rwdWeight）共用的小純函式。
// 注意：幾何「線段相交」測試**不在**此處共用——hillClimb（整數格精確 orient）、
// skeleton（經緯度浮點參數式）、rwdMap（pixel 含容差）三者空間與容差語意不同，
// 硬併會改浮點行為。

/** 無向 pair key：'a|b'（字典序小的在前）。 */
export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** 經緯度座標 key（6 位小數 ≈ 0.1m，資料層寫入精度）。 */
export const coordKey = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`

/** 兩個 route id Set 是否有交集（掃小集合）。 */
export const sharesRoute = (r1, r2) => {
  const [small, big] = r1.size <= r2.size ? [r1, r2] : [r2, r1]
  for (const id of small) if (big.has(id)) return true
  return false
}

/** 段 AB 是否水平/垂直：恰一座標相等（兩座標都等＝退化不算）。 */
export const isHV = (A, B) => (A[0] === B[0]) !== (A[1] === B[1])

/** 段 AB 是否已對齊「H/V 或格對角 45°」：水平/垂直，或 |dc|===|dr|（非零，格座標
 *  對角）。注意這是「格座標」45°；版面非正方時 RWD 會把它畫成 45°＋軸向的斜線。
 *  接受準則見 hillClimb.scoreAlign——**能 H/V 就優先 H/V，45° 次之**。 */
export const isHVD = (A, B) => {
  const dc = Math.abs(A[0] - B[0]), dr = Math.abs(A[1] - B[1])
  return (dc === 0) !== (dr === 0) || (dc === dr && dc !== 0)
}
