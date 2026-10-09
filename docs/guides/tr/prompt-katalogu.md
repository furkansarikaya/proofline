# Prompt kataloğu

Ajan oturumuna yapıştırabileceğin prompt'lar. Claude Code'da `/proofline <alt komut>` kullan; başka yerlerde terminalde
`proofline <alt komut>` çalıştır (runtime'ın için tam talimatı yazdırır) veya aynısını düz cümleyle söyle.
English: [../prompt-catalogue.md](../prompt-catalogue.md).

## Kurulum

| Amaç | Prompt |
|---|---|
| Bu projeye kur | `/proofline init` |
| Önce önizle | `proofline init --dry-run` |
| Her şeyin zorlandığını kontrol et | `/proofline doctor` |
| Control plane'i güncelle | `/proofline upgrade` |
| Neredeyim? | `/proofline status` |

## Task'lar

| Amaç | Prompt |
|---|---|
| Tek cümleden task yaz | `/proofline task Fatura sayfasına CSV export butonu ekle` |
| Önce beni sorgula (belirsiz veya büyük iş) | `/proofline task --grill Retry mantığını baştan tasarla` |
| Task'ı çalıştır | `/proofline run TASK-001` |
| Plan onayı için durmadan çalıştır | `/proofline run TASK-001, bunu sormadan bitir` |
| Sırada ne var? | `/proofline queue` |
| Issue içe aktar (github adapter) | `/proofline task import issue 42` |

## Tasarım dokümanları

| Amaç | Prompt |
|---|---|
| Koddan mimari | `/proofline design system` |
| Şemadan veri modeli | `/proofline design data` |
| API sözleşmesi | `/proofline design api` |
| UI'dan design system | `/proofline design ui` |
| Sapma kontrolü | `/proofline design system --check` |

## Review, audit, debug (tek başına)

| Amaç | Prompt |
|---|---|
| Commit'lenmemiş işimi incele | `/proofline review` |
| Bir branch'i niyetine göre incele | `/proofline review bu branch; niyet PR açıklamasında` |
| Testlere ne kadar güvenebilirim? | `/proofline audit` |
| Kanıtla debug et | `/proofline debug kupon ve hediye kartı birlikte kullanılınca checkout toplamı yanlış` |

## Run sırasında

| Durum | Prompt |
|---|---|
| Planı onayla | `Planı onaylıyorum` |
| Aktarılan soruyu cevapla | numaralı soruları kendi cümlenle doğrudan cevapla |
| Gate FAIL oldu, düzeltsin | `devam et` (fix loop en fazla 2 tur çalışır) |
| Güvenlik dışı tek bir bulguyu waive et | `RULES-3 waive edilsin, onaylıyorum, çünkü legacy modül gelecek sprint değişiyor` (bulgu id'si ve somut gerekçe; güvenlik ve secret bulguları waive edilemez) |
| Tur hakkı bittikten sonra ek tur | `Bir round daha onaylıyorum` |
| Runtime limiti dolduktan sonra devam | diğer runtime'da `/proofline resume` |
| Neden bloke? | `/proofline status` ve `proofline doctor` |

## Teslim

| Amaç | Prompt |
|---|---|
| Commit veya push ne yapar? | `/proofline deliver TASK-001` |
| Commit | `TASK-001 için commit'i onaylıyorum` |
| Push | `TASK-001 için push'u onaylıyorum` |
| Biten run'ları temizle | `proofline clean --yes` |

Onaylar yalnızca senin mesajından (veya terminalde yazdığın cevaptan), isteğin ardından gelirse sayılır ve tek kullanımlıktır.
Kabul edilen onay ifadeleri `.agents/config.yaml` içindeki `approval.phrases` ile belirlenir; kendi ifadelerini oraya ekleyebilirsin.

Bkz. [gunluk-kullanim.md](gunluk-kullanim.md).
