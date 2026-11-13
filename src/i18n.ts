// Khmer strings carried over from the first prototype where they existed.
// Anything missing falls back to English. Have a native speaker review before go-live.
const km: Record<string, string> = {
  Sell: 'បញ្ជរលក់', Stock: 'ស្តុក', Menu: 'ម៉ឺនុយ', Reports: 'របាយការណ៍', Shift: 'វេនការងារ', Admin: 'គ្រប់គ្រង',
  Logout: 'ចាកចេញ', Total: 'សរុប', Pay: 'ទូទាត់ប្រាក់', Cash: 'សាច់ប្រាក់', Tab: 'Tab', 'Open tabs': 'Tabs ដែលកំពុងបើក',
  'Happy Hour': 'ម៉ោងរីករាយ', Cancel: 'បោះបង់', Staff: 'បុគ្គលិក', Suppliers: 'អ្នកផ្គត់ផ្គង់', Waste: 'កំណត់ត្រាខូចខាត',
  'Stock in': 'បញ្ចូលស្តុក', Reason: 'មូលហេតុ', Unit: 'ឯកតា', Category: 'ប្រភេទ', Amount: 'ចំនួនទឹកប្រាក់',
  'Low stock': 'ទំនិញតិច', 'Customer or table name': 'ឈ្មោះអតិថិជន', 'Confirm paid': 'បញ្ជាក់ការបង់ប្រាក់',
  'Enter PIN': 'បញ្ចូលលេខកូដ', Card: 'កាត', Change: 'ប្រាក់អាប់', Done: 'រួចរាល់', Save: 'រក្សាទុក',
};
export type Lang = 'en' | 'km';
export const tr = (lang: Lang) => (s: string) => (lang === 'km' ? km[s] ?? s : s);
