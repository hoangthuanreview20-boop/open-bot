/**
 * Benchmark task generator — dữ liệu synthetic tự tạo (v1.01, Đội T5).
 *
 * Ý tưởng học từ LongMemEval (chỉ ý tưởng benchmark: hỏi–đáp trên tài
 * liệu dài, đo recall/accuracy — KHÔNG lấy dataset, câu hỏi hay đáp án
 * nào của họ): mọi persona, tài liệu và câu hỏi ở đây đều do PRNG có
 * seed sinh ra từ danh sách tên/địa danh/sở thích bịa sẵn. Chạy lại
 * với cùng seed cho cùng một bộ task → kết quả so sánh được giữa các
 * lần chạy và giữa các cấu hình memory.
 *
 * 4 loại task:
 *  - `single-hop`: câu hỏi cần đúng 1 note (gold = note đó).
 *  - `multi-hop`: cần nối 2 note (vd "người thích X sống ở đâu?" —
 *    note 1: A thích X; note 2: A sống ở Y; gold = cả 2 note).
 *  - `temporal`: fact đã bị supersede — đáp án đúng là bản MỚI NHẤT
 *    (gold = note mới; note cũ là distractor có chủ đích).
 *  - `distractor`: có một note gần giống nhưng sai (cùng chủ thể, tân
 *    ngữ khác) — đo xem recall có bị lừa không (gold = note đúng).
 *
 * Mỗi task: `id`, `kind`, `question`, `documents` (note cần ingest),
 * `goldNoteIds`, `expectedAnswer` (chuẩn hoá để chấm accuracy).
 */

import type { NoteKind } from '../types';

/** Loại benchmark task. */
export type BenchmarkTaskKind = 'single-hop' | 'multi-hop' | 'temporal' | 'distractor';

/** Một task benchmark. */
export interface BenchmarkTask {
  id: string;
  kind: BenchmarkTaskKind;
  /** Câu hỏi (tiếng Việt hoặc tiếng Anh — theo `language`). */
  question: string;
  /** Đáp án đúng, dạng chuẩn hoá (để chấm accuracy bằng so khớp). */
  expectedAnswer: string;
  /** Note cần có trong kho để trả lời đúng (gold). */
  goldNoteIds: string[];
  /** Note gây nhiễu (distractor / bản cũ đã supersede) — không được tính là gold. */
  distractorNoteIds: string[];
  /** Ngôn ngữ câu hỏi: 'vi' | 'en'. */
  language: 'vi' | 'en';
}

/** Một document synthetic để ingest thành note trước khi chạy benchmark. */
export interface BenchmarkDocument {
  /** Id ổn định để task trỏ tới (goldNoteIds dùng id này). */
  noteId: string;
  title: string;
  body: string;
  kind: NoteKind;
  tags: string[];
  /** true = document này là bản cũ đã bị supersede (temporal task). */
  supersededBy?: string;
}

/** Một bộ benchmark đầy đủ: documents + tasks + seed. */
export interface BenchmarkSuite {
  seed: number;
  generatedAt: string;
  documents: BenchmarkDocument[];
  tasks: BenchmarkTask[];
  /** Thống kê theo loại task. */
  taskCounts: Record<BenchmarkTaskKind, number>;
}

/** PRNG có seed (mulberry32) — chạy lại cho cùng kết quả. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function pickDistinct<T>(rand: () => number, arr: readonly T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  while (copy.length > 0 && out.length < n) {
    out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  }
  return out;
}

// --- Từ vựng synthetic (bịa hoàn toàn, không lấy từ dataset nào) --------

const FIRST_NAMES_VI = [
  'An', 'Bình', 'Chi', 'Dũng', 'Hà', 'Hùng', 'Lan', 'Minh', 'Ngọc', 'Phúc',
  'Quân', 'Thu', 'Tùng', 'Vy', 'Đức', 'Hạnh', 'Khoa', 'Linh', 'Nam', 'Trang',
] as const;
const FIRST_NAMES_EN = [
  'Alex', 'Maya', 'Jordan', 'Sofia', 'Liam', 'Emma', 'Noah', 'Ava', 'Lucas', 'Mia',
  'Ethan', 'Zoe', 'Owen', 'Lily', 'Caleb', 'Nora', 'Felix', 'Ivy', 'Hugo', 'Ruby',
] as const;
const CITIES_VI = [
  'Hà Nội', 'TP. Hồ Chí Minh', 'Đà Nẵng', 'Hải Phòng', 'Cần Thơ', 'Huế', 'Nha Trang',
  'Đà Lạt', 'Vũng Tàu', 'Quy Nhơn', 'Hạ Long', 'Vinh',
] as const;
const CITIES_EN = [
  'Hanoi', 'Saigon', 'Da Nang', 'Haiphong', 'Can Tho', 'Hue', 'Nha Trang',
  'Da Lat', 'Vung Tau', 'Quy Nhon', 'Ha Long', 'Vinh',
] as const;
const FOODS_VI = [
  'phở bò', 'bún chả', 'bánh mì', 'cơm tấm', 'bún bò Huế', 'mì Quảng', 'chả cá Lã Vọng',
  'bánh xèo', 'gỏi cuốn', 'cà phê sữa đá', 'trà sữa', 'bánh cuốn',
] as const;
const FOODS_EN = [
  'beef pho', 'bun cha', 'banh mi', 'broken rice', 'bun bo Hue', 'mi Quang',
  'cha ca', 'banh xeo', 'spring rolls', 'iced milk coffee', 'bubble tea', 'banh cuon',
] as const;
const HOBBIES_VI = [
  'chạy bộ', 'đọc sách', 'nấu ăn', 'chụp ảnh', 'đạp xe', 'bơi lội', 'chơi guitar',
  'làm vườn', 'du lịch', 'vẽ tranh', 'câu cá', 'leo núi',
] as const;
const HOBBIES_EN = [
  'running', 'reading', 'cooking', 'photography', 'cycling', 'swimming', 'playing guitar',
  'gardening', 'travelling', 'painting', 'fishing', 'hiking',
] as const;
const JOBS_VI = [
  'kỹ sư phần mềm', 'bác sĩ', 'giáo viên', 'kiến trúc sư', 'đầu bếp', 'nhiếp ảnh gia',
  'nhà văn', 'luật sư', 'y tá', 'kỹ sư xây dựng', 'thiết kế đồ hoạ', 'phi công',
] as const;
const JOBS_EN = [
  'software engineer', 'doctor', 'teacher', 'architect', 'chef', 'photographer',
  'writer', 'lawyer', 'nurse', 'civil engineer', 'graphic designer', 'pilot',
] as const;
const SURNAMES_VI = [
  'Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng',
  'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương', 'Lý', 'Trịnh', 'Đinh', 'Lâm', 'Cao',
] as const;
const SURNAMES_EN = [
  'Nguyen', 'Smith', 'Johnson', 'Lee', 'Kim', 'Garcia', 'Patel', 'Chen', 'Wilson', 'Brown',
  'Taylor', 'Anderson', 'Thomas', 'Moore', 'Martin', 'Walker', 'Hall', 'Allen', 'Young', 'King',
] as const;
const PETS_VI = ['mèo', 'chó', 'chim', 'cá vàng', 'thỏ', 'rùa'] as const;
const PETS_EN = ['cat', 'dog', 'bird', 'goldfish', 'rabbit', 'turtle'] as const;
const COLORS_VI = ['đỏ', 'xanh dương', 'xanh lá', 'vàng', 'tím', 'cam', 'hồng', 'trắng', 'đen'] as const;
const COLORS_EN = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'white', 'black'] as const;

/** Cấu hình sinh suite. */
export interface GenerateSuiteOptions {
  seed?: number;
  /** Số persona (mỗi persona sinh ~6 note). Mặc định 10. */
  personas?: number;
  /** Tỉ lệ task tiếng Việt (còn lại tiếng Anh). Mặc định 0.5. */
  vietnameseRatio?: number;
}

interface PersonaFacts {
  name: string;
  city: string;
  food: string;
  hobby: string;
  job: string;
  pet: string;
  color: string;
  language: 'vi' | 'en';
}

/** Sinh một bộ benchmark đầy đủ từ seed. */
export function generateBenchmarkSuite(opts: GenerateSuiteOptions = {}): BenchmarkSuite {
  const seed = opts.seed ?? 10101;
  const rand = seededRandom(seed);
  const personaCount = opts.personas ?? 10;
  const viRatio = opts.vietnameseRatio ?? 0.5;

  const documents: BenchmarkDocument[] = [];
  const tasks: BenchmarkTask[] = [];
  let taskSeq = 0;
  const nextTaskId = (kind: BenchmarkTaskKind) => `task-${kind}-${++taskSeq}`;

  for (let p = 0; p < personaCount; p++) {
    const language: 'vi' | 'en' = rand() < viRatio ? 'vi' : 'en';
    const names = language === 'vi' ? FIRST_NAMES_VI : FIRST_NAMES_EN;
    const surnames = language === 'vi' ? SURNAMES_VI : SURNAMES_EN;
    // Họ riêng cho mỗi persona: tên đầy đủ phải phân biệt được giữa các
    // persona (token họ là tín hiệu phân biệt chính cho BM25 — tên riêng
    // một âm tiết như "An" là stopword nên không dùng được).
    const name = `${pick(rand, names)} ${pick(rand, surnames)}`;
    const cities = language === 'vi' ? CITIES_VI : CITIES_EN;
    const foods = language === 'vi' ? FOODS_VI : FOODS_EN;
    const hobbies = language === 'vi' ? HOBBIES_VI : HOBBIES_EN;
    const jobs = language === 'vi' ? JOBS_VI : JOBS_EN;
    const pets = language === 'vi' ? PETS_VI : PETS_EN;
    const colors = language === 'vi' ? COLORS_VI : COLORS_EN;
    const [city, food, hobby, job, pet, color] = [
      pick(rand, cities), pick(rand, foods), pick(rand, hobbies),
      pick(rand, jobs), pick(rand, pets), pick(rand, colors),
    ];
    const facts: PersonaFacts = { name, city, food, hobby, job, pet, color, language };
    const prefix = `p${p}`;
    const doc = (suffix: string, title: string, body: string, kind: NoteKind, tags: string[]): BenchmarkDocument => {
      const d: BenchmarkDocument = { noteId: `${prefix}-${suffix}`, title, body, kind, tags };
      documents.push(d);
      return d;
    };

    if (language === 'vi') {
      const foodDoc = doc('food', `${name} thích ăn gì`, `${name} rất thích ăn ${food}. Món này là món khoái khẩu của ${name}.`, 'preference', ['an-uong', 'so-thich']);
      const hobbyDoc = doc('hobby', `Sở thích của ${name}`, `Vào cuối tuần, ${name} thường dành thời gian cho ${hobby}.`, 'preference', ['so-thich', 'giai-tri']);
      const jobDoc = doc('job', `Nghề nghiệp của ${name}`, `${name} làm nghề ${job}.`, 'fact', ['nghe-nghiep']);
      const petDoc = doc('pet', `Thú cưng của ${name}`, `${name} nuôi một con ${pet} ở nhà.`, 'fact', ['thu-cung']);
      const colorDoc = doc('color', `Màu yêu thích của ${name}`, `Màu yêu thích của ${name} là ${color}.`, 'preference', ['mau-sac', 'so-thich']);
      // temporal: persona chuyển thành phố — bản cũ bị supersede, bản mới
      // LÀ fact thành phố hiện tại (không tạo thêm doc city riêng để tránh
      // trùng lặp fact lấn át gold của temporal task).
      const oldCity = pickDistinct(rand, CITIES_VI.filter((c) => c !== city), 1)[0];
      const oldCityDoc = doc('city-old', `${name} sống ở đâu (trước đây)`, `${name} trước đây sống ở ${oldCity}.`, 'place', ['dia-chi']);
      const newCityDoc = doc('city-new', `${name} sống ở đâu (hiện tại)`, `${name} đã chuyển tới sống ở ${city}. Hiện tại ${name} sống ở ${city}.`, 'place', ['dia-chi']);
      oldCityDoc.supersededBy = newCityDoc.noteId;
      // single-hop: hỏi thẳng một fact.
      tasks.push({
        id: nextTaskId('single-hop'),
        kind: 'single-hop',
        question: `${name} thích ăn món gì?`,
        expectedAnswer: food,
        goldNoteIds: [foodDoc.noteId],
        distractorNoteIds: [],
        language,
      });
      tasks.push({
        id: nextTaskId('single-hop'),
        kind: 'single-hop',
        question: `${name} làm nghề gì?`,
        expectedAnswer: job,
        goldNoteIds: [jobDoc.noteId],
        distractorNoteIds: [],
        language,
      });
      // multi-hop: nối 2 note (người thích X → sống ở đâu).
      tasks.push({
        id: nextTaskId('multi-hop'),
        kind: 'multi-hop',
        question: `Người thích ăn ${food} thì sống ở thành phố nào?`,
        expectedAnswer: city,
        goldNoteIds: [foodDoc.noteId, newCityDoc.noteId],
        distractorNoteIds: [],
        language,
      });
      tasks.push({
        id: nextTaskId('multi-hop'),
        kind: 'multi-hop',
        question: `${name} nuôi con gì và thường làm gì vào cuối tuần?`,
        expectedAnswer: `${pet}; ${hobby}`,
        goldNoteIds: [petDoc.noteId, hobbyDoc.noteId],
        distractorNoteIds: [],
        language,
      });
      // distractor: persona khác thích món khác — hỏi về persona này.
      const otherFood = pickDistinct(rand, FOODS_VI.filter((f) => f !== food), 1)[0];
      const distractorDoc = doc('distractor-food', `${name} không thích ăn gì`, `Lưu ý: ${name} không thích ăn ${otherFood}.`, 'preference', ['an-uong']);
      tasks.push({
        id: nextTaskId('distractor'),
        kind: 'distractor',
        question: `${name} thích ăn món gì nhất?`,
        expectedAnswer: food,
        goldNoteIds: [foodDoc.noteId],
        distractorNoteIds: [distractorDoc.noteId],
        language,
      });
      // temporal: persona chuyển thành phố — bản cũ bị supersede.
      tasks.push({
        id: nextTaskId('temporal'),
        kind: 'temporal',
        question: `${name} hiện tại sống ở thành phố nào?`,
        expectedAnswer: city,
        goldNoteIds: [newCityDoc.noteId],
        distractorNoteIds: [oldCityDoc.noteId],
        language,
      });
      void colorDoc;
    } else {
      const foodDoc = doc('food', `What does ${name} like to eat`, `${name} really likes eating ${food}. It is ${name}'s favourite dish.`, 'preference', ['food', 'hobby']);
      const hobbyDoc = doc('hobby', `${name}'s hobby`, `On weekends, ${name} usually spends time on ${hobby}.`, 'preference', ['hobby', 'leisure']);
      const jobDoc = doc('job', `${name}'s job`, `${name} works as a ${job}.`, 'fact', ['job']);
      const petDoc = doc('pet', `${name}'s pet`, `${name} keeps a ${pet} at home.`, 'fact', ['pet']);
      const colorDoc = doc('color', `${name}'s favourite colour`, `${name}'s favourite colour is ${color}.`, 'preference', ['colour', 'hobby']);
      // temporal: the persona moved — the old doc is superseded and the
      // new doc IS the current-city fact (no separate city doc, to avoid
      // a duplicate fact outranking the temporal gold).
      const oldCity = pickDistinct(rand, CITIES_EN.filter((c) => c !== city), 1)[0];
      const oldCityDoc = doc('city-old', `Where ${name} used to live`, `${name} used to live in ${oldCity}.`, 'place', ['address']);
      const newCityDoc = doc('city-new', `Where ${name} lives now`, `${name} has moved to ${city}. ${name} now lives in ${city}.`, 'place', ['address']);
      oldCityDoc.supersededBy = newCityDoc.noteId;
      tasks.push({
        id: nextTaskId('single-hop'),
        kind: 'single-hop',
        question: `What does ${name} like to eat?`,
        expectedAnswer: food,
        goldNoteIds: [foodDoc.noteId],
        distractorNoteIds: [],
        language,
      });
      tasks.push({
        id: nextTaskId('single-hop'),
        kind: 'single-hop',
        question: `What is ${name}'s job?`,
        expectedAnswer: job,
        goldNoteIds: [jobDoc.noteId],
        distractorNoteIds: [],
        language,
      });
      tasks.push({
        id: nextTaskId('multi-hop'),
        kind: 'multi-hop',
        question: `The person who likes eating ${food} lives in which city?`,
        expectedAnswer: city,
        goldNoteIds: [foodDoc.noteId, newCityDoc.noteId],
        distractorNoteIds: [],
        language,
      });
      tasks.push({
        id: nextTaskId('multi-hop'),
        kind: 'multi-hop',
        question: `What pet does ${name} keep, and what does ${name} usually do on weekends?`,
        expectedAnswer: `${pet}; ${hobby}`,
        goldNoteIds: [petDoc.noteId, hobbyDoc.noteId],
        distractorNoteIds: [],
        language,
      });
      const otherFood = pickDistinct(rand, FOODS_EN.filter((f) => f !== food), 1)[0];
      const distractorDoc = doc('distractor-food', `What ${name} does not like`, `Note: ${name} does not like eating ${otherFood}.`, 'preference', ['food']);
      tasks.push({
        id: nextTaskId('distractor'),
        kind: 'distractor',
        question: `What is ${name}'s favourite dish?`,
        expectedAnswer: food,
        goldNoteIds: [foodDoc.noteId],
        distractorNoteIds: [distractorDoc.noteId],
        language,
      });
      tasks.push({
        id: nextTaskId('temporal'),
        kind: 'temporal',
        question: `Which city does ${name} live in now?`,
        expectedAnswer: city,
        goldNoteIds: [newCityDoc.noteId],
        distractorNoteIds: [oldCityDoc.noteId],
        language,
      });
      void colorDoc;
    }
  }

  const taskCounts: Record<BenchmarkTaskKind, number> = {
    'single-hop': 0,
    'multi-hop': 0,
    temporal: 0,
    distractor: 0,
  };
  for (const task of tasks) taskCounts[task.kind]++;

  return {
    seed,
    generatedAt: new Date().toISOString(),
    documents,
    tasks,
    taskCounts,
  };
}

/**
 * Xáo trộn task bằng seed (để chạy theo thứ tự ngẫu nhiên nhưng lặp lại
 * được). Dùng Fisher–Yates với PRNG có seed.
 */
export function shuffleTasks(tasks: BenchmarkTask[], seed: number): BenchmarkTask[] {
  const rand = seededRandom(seed ^ 0x9e3779b9);
  const copy = [...tasks];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
