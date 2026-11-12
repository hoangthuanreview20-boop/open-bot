/**
 * Corpus benchmark cho hiệu chuẩn `estimateTokens` (W17b, v0.24).
 *
 * 22 mẫu text THẬT (đoạn văn / code viết tay, không chuỗi lặp vô nghĩa),
 * chia 6 nhóm — mỗi nhóm ≥3 mẫu:
 *  - en: văn xuôi tiếng Anh (4 đoạn ~360–410 ký tự)
 *  - vi: văn xuôi tiếng Việt có dấu (4 đoạn ~330–405 ký tự)
 *  - code: code JS/TS thật (4 đoạn ~440–740 ký tự)
 *  - cjk: văn xuôi Trung / Nhật / Hàn (4 đoạn ~107–153 ký tự)
 *  - num: text nhiều số — số dài, đơn hàng, tiền tệ, tọa độ (3 mẫu)
 *  - special: chuỗi ký tự đặc biệt, tin nhắn emoji, email forward (3 mẫu)
 *
 * Số token THẬT đo bằng `tiktoken` 1.0.22, `cl100k_base`
 * (xem `tests/token-estimate-v020.test.mjs` — test tính live từ corpus
 * này, không hard-code số thật ở đây để tránh lệch khi đổi tokenizer):
 *  - en:      thật 74, 78, 67, 74
 *  - vi:      thật 165, 166, 195, 185
 *  - code:    thật 105, 181, 131, 136
 *  - cjk:     thật 158, 140, 153, 120
 *  - num:     thật 64, 110, 79
 *  - special: thật 57, 122, 74
 *
 * Sai số đo được của `estimateTokens` mới trên corpus này (xem test):
 * en 3.1% / vi 0.4% / code 4.6% / cjk 1.4% / num 0.0% / special 6.2%
 * (trung bình |sai số tương đối| mỗi nhóm; toàn corpus 2.6%).
 * Heuristic v0.21 cũ trên cùng corpus: 30.3% / 38.4% / 22.2% /
 * 19.2% / 6.9% / 42.9% (toàn corpus 26.8%).
 */
export const CORPUS = {
  en: [
    `The city council announced on Tuesday that the old riverside market will be renovated over the next eighteen months. Vendors who have sold fruit and flowers there for decades will move to a temporary hall nearby while builders repair the roof, widen the walkways and install a new drainage system. Many residents welcomed the plan, though some worried about higher rents once the work is finished.`,
    `When Maya opened the bakery, she had only a second-hand oven, a notebook full of recipes from her grandmother, and a loan she was determined to repay within three years. The first winter was difficult: flour prices rose, the heating broke twice, and regular customers were few. But word spread slowly through the neighbourhood, and by spring the queue on Saturday mornings stretched halfway down the street.`,
    `Scientists studying deep ocean currents have found that warm water is reaching the Antarctic ice shelves faster than earlier models predicted. The measurements, taken by autonomous submarines over five years, show narrow channels of warm water cutting beneath the ice. If the trend continues, the researchers warn, sea levels could rise more quickly than coastal cities are currently preparing for.`,
    `Learning to play the piano as an adult is humbling in a way that few hobbies are. Your hands refuse to cooperate, your reading is slow, and pieces that sound simple turn out to be full of hidden traps. Yet the small victories keep you going: the first time a scale flows smoothly, the evening a familiar melody finally sounds like music instead of a struggle.`,
  ],
  vi: [
    `Thành phố Hồ Chí Minh đang bước vào mùa mưa với những cơn mưa rào bất chợt vào buổi chiều. Người dân đi làm về thường phải dừng lại trú mưa dưới mái hiên, chờ cơn mưa ngớt rồi mới tiếp tục về nhà. Các tuyến đường ở khu vực trung tâm thường bị ngập nhẹ, xe cộ di chuyển chậm, nhưng không khí sau mưa lại mát mẻ và dễ chịu hơn nhiều.`,
    `Món phở đã trở thành biểu tượng ẩm thực của Việt Nam, được nhiều du khách nước ngoài yêu thích. Một bát phở ngon phải có nước dùng trong, ngọt thanh từ xương hầm nhiều giờ, bánh phở mềm mà không nát, thịt bò thái mỏng vừa chín tới. Người bán thường dậy từ rất sớm để chuẩn bị, và quán đông nhất vào buổi sáng khi mọi người bắt đầu một ngày mới.`,
    `Việc học trực tuyến đã thay đổi cách nhiều sinh viên tiếp cận kiến thức trong những năm gần đây. Thay vì phải đến giảng đường mỗi ngày, họ có thể xem lại bài giảng bất cứ lúc nào, trao đổi với giảng viên qua diễn đàn và làm bài tập theo tốc độ của riêng mình. Tuy nhiên, không ít người thừa nhận rằng họ dễ mất tập trung hơn khi học ở nhà, thiếu đi không khí lớp học và sự tương tác trực tiếp với bạn bè.`,
    `Chợ nổi Cái Răng ở Cần Thơ là một trong những điểm đến đặc biệt của miền Tây sông nước. Từ sáng sớm, hàng trăm ghe thuyền đã tấp nập chở đầy trái cây, rau củ và hàng hóa. Tiếng rao hàng, tiếng máy nổ và mùi thơm của cà phê, bún riêu hòa quyện trong không khí. Du khách ngồi trên ghe len lỏi giữa dòng sông, cảm nhận nhịp sống hối hả mà bình dị của người dân nơi đây.`,
  ],
  code: [
    `async function fetchUserProfile(userId) {\n  const response = await fetch(\`/api/users/\${userId}\`, {\n    method: 'GET',\n    headers: { 'Authorization': \`Bearer \${token}\`, 'Content-Type': 'application/json' },\n  });\n  if (!response.ok) {\n    throw new Error(\`Failed to fetch user \${userId}: \${response.status}\`);\n  }\n  const data = await response.json();\n  return { ...data, displayName: data.name.trim(), lastSeen: new Date(data.updatedAt) };\n}`,
    `export class LruCache<K, V> {\n  private readonly capacity: number;\n  private readonly entries = new Map<K, V>();\n\n  constructor(capacity: number) {\n    if (capacity <= 0) throw new RangeError('capacity must be positive');\n    this.capacity = capacity;\n  }\n\n  get(key: K): V | undefined {\n    const value = this.entries.get(key);\n    if (value === undefined) return undefined;\n    this.entries.delete(key);\n    this.entries.set(key, value);\n    return value;\n  }\n\n  set(key: K, value: V): void {\n    if (this.entries.has(key)) this.entries.delete(key);\n    else if (this.entries.size >= this.capacity) {\n      const oldest = this.entries.keys().next().value!;\n      this.entries.delete(oldest);\n    }\n    this.entries.set(key, value);\n  }\n}`,
    `const total = orders\n  .filter((order) => order.status === 'paid' && order.createdAt >= startOfMonth)\n  .reduce((sum, order) => sum + order.items.reduce((s, item) => s + item.price * item.quantity, 0), 0);\nconst discount = total > 1000 ? total * 0.1 : total > 500 ? total * 0.05 : 0;\nconsole.log(\`Total: $\${total.toFixed(2)}, discount: $\${discount.toFixed(2)}\`);\nconst summary = { total, discount, payable: total - discount, count: orders.length };`,
    `import { useEffect, useState } from 'react';\n\nexport function useDebounce<T>(value: T, delayMs = 300): T {\n  const [debounced, setDebounced] = useState(value);\n  useEffect(() => {\n    const timer = setTimeout(() => setDebounced(value), delayMs);\n    return () => clearTimeout(timer);\n  }, [value, delayMs]);\n  return debounced;\n}\n\nconst re = /^(\\d{4})-(\\d{2})-(\\d{2})$/;\nconst match = re.exec('2026-11-09');\nif (match) console.log(match.slice(1).join('/'));`,
  ],
  cjk: [
    `中国是一个历史悠久的国家，拥有丰富的文化遗产。从长城到故宫，从西湖到黄山，每一处风景都承载着千年的故事。近年来，随着经济的快速发展，许多城市发生了巨大的变化，高楼大厦拔地而起，交通网络日益完善。人们的生活水平不断提高，越来越多的人开始关注环境保护和生活质量。`,
    `日本は四季がはっきりとした美しい国です。春には桜が咲き誇り、夏には花火大会が各地で開かれます。秋の紅葉は山々を赤や黄色に染め、冬には温泉で体を温めることができます。日本料理も世界中で人気があり、寿司やラーメンは今や世界共通の言葉になりました。`,
    `서울은 한국의 수도로, 전통과 현대가 공존하는 도시입니다. 경복궁과 같은 역사적인 장소 옆에는 높은 빌딩과 쇼핑몰이 자리하고 있습니다. 한국 음식은 매운맛과 다양한 반찬으로 유명하며, 최근에는 케이팝과 드라마 덕분에 전 세계적으로 한국 문화에 대한 관심이 높아지고 있습니다.`,
    `人工智能正在改变我们的生活方式。从智能手机的语音助手到自动驾驶汽车，从医疗诊断到金融分析，AI技术已经深入到各个领域。专家认为，未来十年内，人工智能将会带来更多的创新，同时也需要我们认真思考它带来的伦理和社会问题。`,
  ],
  num: [
    `2026110912345678901234567890 98765432109876543210 123456789012345678901234567890 31415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679`,
    `Order numbers: 84739201, 84739202, 84739203. Invoice totals: 1299000, 2450000, 899000 VND. Phone: 0901234567, 0912345678. Dates: 2026-11-09, 2025-12-31, 2024-02-29. Prices: 19.99, 249.50, 1,299,000. Coordinates: 10.762622, 106.660172.`,
    `The account balance changed from 123456789.00 to 987654321.55 after transfers of 5000000, 25000000 and 125000000. Reference codes: 7788990011223344556677889900, 11223344556677889900. Percentages: 3.14159%, 99.99%, 0.001%.`,
  ],
  special: [
    `!!! ??? ... --- *** ### $$$ &&& ||| >>> <<< === !== <= >= += -= *= /= => -> :: ;; ,, .. ((())) [[[]]] {{{}}} \\\\ // || && ^^ ~~ \`\`\` --- *** ___ +++ @@@ ### %%% ^^^ &&& *** |||`,
    `🎉🎊🥳 Happy birthday!!! 🎂🎈🎁🎉 Wishing you all the best 😊😍🥰❤️💕✨🌟💫🔥👏🙌🎶🎵 Have an amazing day! 🥂🍾🎇🎆🎉🎊😄😃😁🤣😂🙂😉😘🥰😍🤩🥳🤪😜😝`,
    `>>>>> Original message <<<<< -----Original Message----- From: John Doe <john@example.com> Sent: Monday, November 9, 2026 9:15 AM To: Jane <jane@example.com> Subject: Re: Re: Fwd: Meeting notes!!! [IMPORTANT] *** Please review ASAP *** @john @jane #urgent #todo !!!`,
  ],
};
