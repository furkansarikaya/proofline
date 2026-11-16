# Prompt kataloğu

<!-- translated-from: docs/guides/prompt-catalogue.md; blob: 34bd46d388f88a91c364781bf11ffbf642772455; commit: f73b7b6f -->

Bu belge, [prompt-catalogue.md](../prompt-catalogue.md) sayfasının `f73b7b6f` sürümünden yapılmış Türkçe çevirisidir; İngilizce sürüm esastır, çeviri geride kalabilir (CI bunu uyarı olarak bildirir).

Ajan oturumuna yapıştırabileceğin prompt'lar. Claude Code'da `/proofline <alt komut>` kullan; başka yerlerde terminalde
`proofline <alt komut>` çalıştır (ajan gerektiren alt komutlar için runtime'ın için tam talimatı yazdırır) veya aynısını düz cümleyle söyle.
`proofline help` her alt komutu listeler.

## Kurulum

| Amaç | Prompt |
|---|---|
| Bu projeye kur | `/proofline init` |
| Önce önizle | `proofline init --dry-run` |
| Her şeyin zorlandığını kontrol et | `/proofline doctor` |
| Control plane'i güncelle | `/proofline upgrade` |
| Neredeyim? | `/proofline status` |
| build, test ve lint komutlarını bul ve kanıtla | `/proofline doctor --commands`, ardından tek sorusuna evet de (`--apply-commands` kanıtlanmış öneriyi yazar) |
| Bu makineyi ölç ve `timeouts.scale` öner | `proofline doctor --scale`, ardından `approve scale` |

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
| Tek bir ekranı parlat (modlar: bolder quieter polish animate typeset colorize layout delight harden adapt) | `/proofline design ui polish the settings page` |

## Dokümantasyon, açıklama, trace

| Amaç | Prompt |
|---|---|
| Dokümantasyonu yaz, bir diff'ten güncelle veya denetle | `/proofline docs create`, `/proofline docs update`, `/proofline docs audit` |
| Bir konuyu ya da task'ı anlatan tek bir çevrimdışı HTML sayfası | `/proofline explain TASK-001` |
| Bir gereksinimi veya task'ı testlerine, run kanıtına ve pull request'ine kadar izle (salt okunur) | `/proofline trace TASK-001` |
| Proje wiki'si tut | `/proofline wiki ingest README.md`, `/proofline wiki query <soru>`, `/proofline wiki lint` |
| Ürün gereksinimleri dokümanı yaz, incele, task'lara böl | `/proofline product prd <slug>`, `/proofline product review <slug>`, `/proofline product split <slug>` |

## Review, audit, debug (tek başına)

| Amaç | Prompt |
|---|---|
| Commit'lenmemiş işimi incele | `/proofline review` |
| Bir branch'i niyetine göre incele | `/proofline review bu branch; niyet PR açıklamasında` |
| Testlere ne kadar güvenebilirim? | `/proofline audit` |
| Kanıtla debug et | `/proofline debug kupon ve hediye kartı birlikte kullanılınca checkout toplamı yanlış` |
| Bir UI değişikliğini tarayıcıda kanıtla (ölçülü; tarayıcı yoksa UNSUPPORTED) | `visual-proof skill'i ile sipariş ekranını design/UI.md'ye göre kontrol et` |
| Bir API veya şema değişikliğinde breaking change var mı (ayrıştıramadığı format UNSUPPORTED) | `openapi.yaml değişikliklerini contract-proof skill'i ile kontrol et` |
| Değişen kodda yarış durumu ve çift işleme ara (sadece kanıtlanmış sorunlar; PASS asla güvenli demek değildir) | `ödeme retry değişikliğini concurrency-proof skill'i ile incele` |
| Performans regresyonunu base ile karşılaştırarak ölç (benchmark komutu yoksa UNSUPPORTED) | `arama değişikliğini performance-proof skill'i ile ölç` |

## Run sırasında

| Durum | Prompt |
|---|---|
| Planı onayla | `Planı onaylıyorum` |
| Aktarılan soruyu cevapla | numaralı soruları kendi cümlenle doğrudan cevapla |
| Gate FAIL oldu, düzeltsin | `devam et` (fix loop en fazla 2 tur çalışır) |
| Güvenlik dışı tek bir bulguyu waive et | `RULES-3 waive edilsin, onaylıyorum, çünkü legacy modül gelecek sprint değişiyor` (bulgu id'si ve somut gerekçe; güvenlik ve secret bulguları waive edilemez) |
| Tur hakkı bittikten sonra ek tur | `Bir round daha onaylıyorum` |
| Plan'ın doğrulayamadığı yüksek riskli bir varsayımı cevapla | mesajı `accept AS-1` ile başlat (id sorudaki id'dir; birden fazla: `accept AS-1 and AS-2`), devamında "not", "if", "unless", "but" ya da Türkçe karşılıkları olmasın; ya da doğrusunu yaz. Başka hiçbir şey onu kabul etmez |
| Bir kontrol UNSUPPORTED döndü | varsayılan olarak bir şey gerekmez: completion report'ta kanıtlanmamış olarak listelenir (`## Unsupported Checks`, `not proven: ...`); kanıtlamak için eksik aracı kendin kur ve yeniden çalıştır |
| Bir kontrol INCONCLUSIVE olarak bloklandı (ya da proje `risk.unsupported: block` kullanıyor) | yeniden çalıştır, ya da açıkça waive et: `görsel kontrol waive edilsin, onaylıyorum, çünkü bu makinede tarayıcı yok` |
| Runtime limiti dolduktan sonra devam | diğer runtime'da `/proofline resume` |
| Neden bloke? | `/proofline status` ve `proofline doctor` |

## Teslim

| Amaç | Prompt |
|---|---|
| Teslim et: commit, push, PR, yeşilse merge, temizlik (tek özet) | `/proofline deliver TASK-001` |
| Özetin tamamını onayla | `approve delivery` (veya `teslimatı onaylıyorum`) |
| Commit | `TASK-001 için commit'i onaylıyorum` |
| Push | `TASK-001 için push'u onaylıyorum` |
| Pull request'i birleştir (güncel head'indeki her check'i kontrol eder) | `proofline merge 42 --squash --delete-branch` |
| Biten run'ları temizle | `proofline clean --yes` |

## Birkaç task birden (gece modu)

| Amaç | Prompt |
|---|---|
| Batch'i planla: tek özet, bağımlılık sırasıyla | `/proofline batch TASK-001 TASK-002` veya `/proofline batch all` |
| Özetin tamamını onayla (task'larının plan ve teslim onayları, başka hiçbir şey) | `approve batch` |
| Özetteki ön kontrol sorularını cevapla | `Q1 a, Q2 b` veya `all recommended` (beklenen bilinen sorunlar listesi için asla) |
| Bir kesintiden sonra devam et | `/proofline batch` |
| Sabah tablosu, yalnızca kayıtlardan | `proofline batch status` |

Ayrıntılar: [night mode](../../concepts/night-mode.md).

Yanıt, türüne ait tam bir cümle (`Planı onaylıyorum`, `Commit'i onaylıyorum`, `Kapsamı onaylıyorum`, ...) ya da `approve plan` gibi kısa bir ifade olmalıdır; fazladan bir yan cümle yanıtı belirsiz yapar ve soru yeniden sorulur.

Onaylar yalnızca senin mesajından (veya terminalde yazdığın cevaptan), isteğin ardından gelirse sayılır ve tek kullanımlıktır.
Kabul edilen onay ifadeleri projenin `.agents/config.yaml` dosyasındaki `approval.phrases` ile belirlenir (virgülle ayrılmış bir liste); varsayılanlar İngilizce ve Türkçedir.

İlgili: [gunluk-kullanim.md](gunluk-kullanim.md).
