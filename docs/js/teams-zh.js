// English country name → Traditional Chinese (HK conventions).
// Used by both main.js and admin.js to render bilingual team labels.
//
// Add new mappings here when knockout-stage teams not in the original
// 48 are needed (e.g. play-off winners).
export const TEAM_ZH = {
  "Mexico":                   "墨西哥",
  "South Africa":             "南非",
  "South Korea":              "南韓",
  "Czechia":                  "捷克",
  "Canada":                   "加拿大",
  "Bosnia and Herzegovina":   "波斯尼亞",
  "Qatar":                    "卡塔爾",
  "Switzerland":              "瑞士",
  "Brazil":                   "巴西",
  "Morocco":                  "摩洛哥",
  "Haiti":                    "海地",
  "Scotland":                 "蘇格蘭",
  "United States":            "美國",
  "Paraguay":                 "巴拉圭",
  "Australia":                "澳洲",
  "Türkiye":                  "土耳其",
  "Germany":                  "德國",
  "Curaçao":                  "庫拉索",
  "Côte d'Ivoire":            "象牙海岸",
  "Ecuador":                  "厄瓜多爾",
  "Netherlands":              "荷蘭",
  "Japan":                    "日本",
  "Tunisia":                  "突尼斯",
  "Sweden":                   "瑞典",
  "Belgium":                  "比利時",
  "Egypt":                    "埃及",
  "Iran":                     "伊朗",
  "New Zealand":              "新西蘭",
  "Spain":                    "西班牙",
  "Cabo Verde":               "佛得角",
  "Saudi Arabia":             "沙特",
  "Uruguay":                  "烏拉圭",
  "France":                   "法國",
  "Senegal":                  "塞內加爾",
  "Iraq":                     "伊拉克",
  "Norway":                   "挪威",
  "England":                  "英格蘭",
  "Croatia":                  "克羅地亞",
  "Ghana":                    "加納",
  "Panama":                   "巴拿馬",
  "Argentina":                "阿根廷",
  "Algeria":                  "阿爾及利亞",
  "Austria":                  "奧地利",
  "Jordan":                   "約旦",
  "Portugal":                 "葡萄牙",
  "Uzbekistan":               "烏茲別克",
  "Colombia":                 "哥倫比亞",
  "DR Congo":                 "民主剛果",
  "TBD":                      "待定",
};

// Render a team label: "Mexico 墨西哥"
export function teamLabel(en) {
  if (!en) return "";
  const zh = TEAM_ZH[en];
  return zh ? `${en} ${zh}` : en;
}

// Short label for cards where space is tight: just English + brief zh
export function teamShort(en) {
  if (!en) return "";
  const zh = TEAM_ZH[en];
  return zh ? `${en} (${zh})` : en;
}
