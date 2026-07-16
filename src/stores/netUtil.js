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
