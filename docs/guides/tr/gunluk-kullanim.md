# Günlük kullanım

English version: [daily-use.md](../daily-use.md).

## Döngü

1. `proofline status` - aktif run ve bir sonraki adım (varsayılan komut).
2. İşi anlat. Küçük ve netse doğrudan söylemen yeterli. Belirsiz veya büyükse `proofline task --grill "<metin>"` önce seninle konuşur, sonra bir task dosyası yazar.
3. `proofline run <TASK>` - lead görevi tüm workflow boyunca yürütür.
4. Lead'in aktardığı soruları cevapla (sorular uzmandan olduğu gibi gelir). COMPLEX ve CRITICAL görevlerde planı onayla.
5. Run CODE_DONE'a geldiğinde tamamlanma raporunu oku, sonra `proofline deliver <TASK>` ile commit veya push'un ne yapacağını gör.
6. Commit (ve push) için kendi cümlenle onay ver. Her biri, o mesajda senin onayını ve o içeriğe ait bir gate geçişini gerektirir.

Claude Code içinde aynı komutlar `/proofline status`, `/proofline run <TASK>` biçimindedir.

## Komutlar

| Komut | Ne işe yarar |
|---|---|
| `proofline init`, `upgrade`, `doctor`, `version` | kurulum, güncelleme (senin değişikliklerini korur, çakışmaları raporlar), doğrulama, sürüm |
| `proofline status`, `resume`, `queue` | ajan oturumu olmadan durum; `resume` duraklama veya runtime değişiminden sonra |
| `proofline task [--grill] <metin>` | task dosyası yaz |
| `proofline run <TASK>` | tam workflow |
| `proofline design system\|data\|api\|ui [--check]` | tasarım dokümanları; `--check` sapmayı raporlar |
| `proofline review`, `audit`, `debug` | proof-review, test-trust ve debug-proof tek başına |
| `proofline deliver <TASK>` | teslim kontrolü; asla commit atmaz |
| `proofline clean [--yes]` | `.agents/local` durumunu ve biten run'ları sil |
| `proofline insights [--run ID] [--json]` | salt okunur rapor: run, rol ve model bazında maliyet (token sadece runtime bildirdiyse) ve tekrar eden başarısızlıklar, öneriler; hiçbir şeyi değiştirmez |

## İyi alışkanlıklar

- Bir task, bir run, bir branch. Task'lar sıraya girer; paralel task'lar ayrı git worktree ister.
- COMPLEX bir görevi onaysız yürütmek için "bunu sormadan bitir" de; soru, yıkıcı işlem, kapsam değişikliği ve teslim durakları yine geçerlidir.
- Bir gate FAIL olursa fix loop çalışsın (varsayılan 2 tur). Waiver için bulgu başına açık mesajın gerekir; güvenlik ve secret bulguları waive edilemez.
- Runtime limiti dolunca diğer runtime'ı aç ve `proofline resume` çalıştır. Bkz. [failover](../../concepts/failover.md).
- Config değiştirdikten veya yükselttikten sonra `proofline doctor` çalıştır.
- Completion report'taki `## Unsupported Checks` ve `## Assumptions` bölümlerini oku: UNSUPPORTED bir kontrol asla geçmiş sayılmadı, doğrulanmamış bir varsayım ya kabul ettiğin ya da hâlâ taşıdığın bir risktir. Kanıt sınıfları: [evidence](../../concepts/evidence.md).
- Neyin doğrulandığını bil: script'ler test edilmiştir ve Claude-only her senaryo bağımsız bir uçtan uca değerlendirmeden bir noktada geçmiştir (2026-10-13 ile 2026-10-17 arası; STANDARD.tr birkaç kez), ancak hiçbiri güncel sürümde yeniden doğrulanmadı; Codex ve failover yapılandırmaları yalnızca kısmen test edildi. Tarihli tablo [tests/e2e/README.md](../../../tests/e2e/README.md#current-results) içinde.
- Ara sıra `proofline insights` çalıştır: maliyetin ve tekrar eden başarısızlıkların nerede toplandığını gösterir, hiçbir şeyi değiştirmez.

Daha fazla örnek: [prompt-katalogu.md](prompt-katalogu.md). Kavramlar: [workflow](../../concepts/workflow.md), [gates](../../concepts/gates.md).
