# Günlük kullanım

<!-- translated-from: docs/guides/daily-use.md; blob: 2cdb0c199c68271698fdb03cf929754a7ac012bb -->

Bu belge, [daily-use.md](../daily-use.md) İngilizce sayfasının Türkçe çevirisidir; çevirinin izlediği İngilizce metnin git blob kimliği dosya başındaki `translated-from` satırındadır. İngilizce sürüm esastır, çeviri geride kalabilir (CI bunu uyarı olarak bildirir).

proofline kurulduktan sonra onunla çalışmanın komutları ve alışkanlıkları: bir istekten birleştirilmiş bir değişikliğe giden döngü, her komutun ne yaptığı ve nelere bakman gerektiği. `proofline init` çalıştırmış ve rutini öğrenmek isteyen herkes için; kurulum [existing project](../existing-project.md) sayfasında.

## Döngü

1. `proofline status` - aktif run ve bir sonraki adım (varsayılan komut).
2. İşi anlat. Küçük ve netse doğrudan söylemen yeterli. Belirsiz veya büyükse `proofline task --grill "<metin>"` önce seninle konuşur, sonra bir task dosyası yazar.
3. `proofline run <TASK>` - lead görevi tüm workflow boyunca yürütür. Komutu yazmak, TRIVIAL bir koşuyu başlatmak için verdiğin onayın kendisidir ("yes" yanıtı beklenmez); koşu yokken sade bir "şunu düzelt" yine önce önerilir ve commit, push ve teslim onayları ayrı kalır (A326).
4. Lead'in aktardığı soruları cevapla (sorular uzmandan olduğu gibi gelir). COMPLEX ve CRITICAL görevlerde planı onayla.
5. Run CODE_DONE'a geldiğinde tamamlanma raporunu oku, sonra `proofline deliver <TASK>` ile teslimin ne yapacağını gör.
6. Ajan oturumunda `/proofline deliver <TASK>` tek bir özet gösterir (commit, push, pull request, yeşilse merge, temizlik). Her adımı onaylamak için `approve delivery` (veya `teslimatı onaylıyorum`) yaz; bir adımdan önce içerik değişirse zincir durur ve yeniden sorulur.

Onay sayılan ifadeler yapılandırılabilir: projenin `.agents/config.yaml` dosyasındaki `approval.phrases` virgülle ayrılmış bir listedir ve varsayılanları İngilizce (`approve`, `yes`, `lgtm`, ...) ve Türkçedir (`onay`, `evet`, `tamam`, ...). Yanıtın ifadelerden birini ve bir tür kelimesini (`plan`, `commit`, `delivery`, ...) içermeli; içindeki her sözcük de bir ifadeye ait olmalı, tür kelimesi olmalı ya da `the` veya `please` gibi bir dolgu sözcüğü olmalıdır; aksi halde yanıt belirsiz sayılır ve soru yeniden sorulur. İki istisna (A350): birden çok run beklerken bekleyen run'ın (veya onaylanan run'ın) kimliği tür kelimesinden sonra gelebilir (`approve scope TASK-004 TASK-010` yalnızca bu iki run'ı onaylar); ve tek mesaj birkaç türü onaylayabilir: `;`, `,` veya satırlarla ayrılmış (`approve scope; approve budget`) ya da her türü adıyla anan tek bir ifadeyle (`approve plan and scope`; `approve all` hiçbir şeyi onaylamaz). Bekleyen bir sorunun yanıtı (`soru 1: a`) aynı mesajda durabilir ve senin yanıtın olarak kaydedilir. `agent.sh config-get approval.phrases` geçerli listeyi yazdırır.

Claude Code içinde aynı komutlar `/proofline status`, `/proofline run <TASK>` ve benzeri biçimdedir. Terminalde bir ajan gerektiren komutlar (`task`, `run`, `design`, `review`, `audit`, `debug`, `docs`, `explain`, `wiki`, `knowledge`, `reopen`, `product`, `trace`, `batch`) senin runtime'ın için tam talimatı yazdırır ve başka bir şey yapmaz; aşağıdaki durum komutları kendi başlarına çalışır. `proofline 0.0.135` ile boş bir projede denendi: `task`, `run`, `review` ve `design system` `This step needs an agent session` yazdırdı; `status`, `queue`, `debt`, `insights`, `clean`, `doctor` ve `doctor --scale` çalıştı ve 0 ile çıktı.

## Komutlar

Control plane Node kodudur; `.agents/scripts/agent.sh` onu başlatan ince bir launcher'dır ([ADR 0001](../../adr/0001-node-control-plane.md)). `proofline help` tam listeyi yazdırır; bu tablo kısa halidir.

| Komut | Ne işe yarar |
|---|---|
| `proofline init`, `upgrade`, `doctor`, `version` | kurulum, güncelleme (senin değişikliklerini korur, çakışmaları raporlar), doğrulama, sürüm |
| `proofline status`, `resume`, `queue` | ajan oturumu olmadan durum; `resume` duraklama veya runtime değişiminden sonra |
| `proofline task [--grill] <metin>` | task dosyası yaz |
| `proofline task --import <issue-url\|numara>` | önerilen: bir GitHub issue task olur; tamamlanma raporu issue'ya yorum olarak yazılır ([task kaynakları](../../concepts/task-sources.md)) |
| `proofline run <TASK>` | tam workflow |
| `proofline design system\|data\|api\|ui [--check]` | tasarım dokümanları; `--check` sapmayı raporlar |
| `proofline design ui <mod> <hedef>` | tek bir UI hedefinde odaklı değişiklik, normal bir run olarak; modlar: `bolder quieter polish animate typeset colorize layout delight harden adapt`; mevcut design system'i korur ve yalnızca hedefe dokunur |
| `proofline review`, `audit`, `debug` | proof-review, test-trust ve debug-proof tek başına |
| `proofline docs create\|update\|audit`, `proofline explain <konu\|TASK-ID>` | dokümantasyonu yaz, bir diff'ten güncelle veya denetle; bir konuyu ya da task'ı anlatan tek bir çevrimdışı HTML sayfası |
| `proofline trace <FR-n\|TASK-ID>` | bir gereksinimi veya task'ı testlerine, run kanıtına ve pull request'ine kadar izle (salt okunur) |
| `proofline product prd\|review\|split <slug>`, `product discover ...`, `product assess ...`, `product outcome <slug>` | ürün gereksinimleri, keşif, varsayım testleri ve yayına çıkan bir değişikliğin ölçülen sonucu ([product](../../concepts/product.md)) |
| `/proofline wiki ingest\|query\|lint` | kalıcı proje wiki'si (llm-wiki skill'i; açma/kapama ayarı yoktur, `/proofline wiki ingest README.md` ile başlat); wiki `docs/wiki/` içinde yaşar, orası varsayılan `knowledge_scope_root` içindedir; bu yüzden her zaman çalışan Knowledge adımı (bkz. `control-plane/agents/KNOWLEDGE.md`) onu güncelleyebilir |
| `proofline knowledge <TASK>`, `reopen <TASK>` | biten run'ın bilgi adımı (wiki, ADR'ler, ders adayları, implementer gözlemlerinden önerilen task'lar); FAILED veya BLOCKED run'ı onayınla workflow'a geri al |
| `proofline debt` | koddaki `shortcut: <sınır>, <ne zaman iyileştirilir>` yorumlarını `dosya:satır` ile listele; salt okunur, run gerekmez |
| `proofline deliver <TASK>` | teslim kontrolü; asla commit atmaz (oturumda `/proofline deliver` tek bir `approve delivery` sonrasında teslim eder); FAILED veya BLOCKED run reddedilir |
| `proofline batch <ID...\|all>` | gece modu, aşağıya bak |
| `proofline clean [--yes]` | `.agents/local` durumunu ve biten run'ları sil |
| `proofline merge <PR> [--merge\|--squash\|--rebase] [--delete-branch]` | izin verilen tek merge yolu: pull request'i yalnızca güncel head'indeki her check yeşilse birleştirir (A136); `--admin` ve `--auto` reddedilir, hook `gh pr merge` ile diğer merge yollarını engeller |
| `proofline insights [--run ID] [--json]` | salt okunur rapor: run, rol ve model bazında maliyet (token sadece runtime bildirdiyse), rol ve run bazında tool çağrıları ve tekrar eden başarısızlıklar, öneriler; hiçbir şeyi değiştirmez |
| `proofline doctor --scale`, `--apply-scale` | bu makineyi ölç ve `timeouts.scale` öner; yalnızca senin `approve scale` onayından sonra yazılır ([timeouts](../../concepts/timeouts.md)) |
| `proofline doctor --commands`, `--apply-commands` | boş `commands.build\|test\|lint` değerlerini bul, her birini tek bir çalıştırmayla kanıtla ve öneriyi senin evetinden sonra yaz |

## Bir gecede birkaç task (batch)

`/proofline batch <ID...|all>` listelenen task'ların tek bir özetini bağımlılık sırasıyla gösterir. O özete bağlı tek bir yanıt, `approve batch`, bu task'ların plan ve teslim onaylarının yerini tutar; CRITICAL task'lar dışarıda bırakılır, waiver, kapsam genişletme, yeni bağımlılık, reopen veya yıkıcı veri değişikliği hiçbir zaman kapsanmaz (task park edilir, ona bağlı olanlar atlanır, bağımsız task'lar devam eder). Lead senin oturumunda çalışır; bu yüzden bilgisayarı uyanık ve oturumu açık tut; bir kesintiden sonra `/proofline batch` kaldığı yerden devam eder ve birleştirilmiş bir task'ı asla yeniden çalıştırmaz. `proofline batch status` sabah tablosunu yalnızca kayıtlardan yazdırır.

- Batch, `depends_on` değerini task dosyalarından okur ve iki task'ı yalnızca ikisi de aynı dosyayı `## Expected scope` listesinde yazmışsa aynı dosyayı paylaşıyor sayar (Context metnindeki bir belge veya adres hiçbir zaman sayılmaz); park edilen bir task yalnızca ona bağlı olanları ve listelenmiş bir dosyayı onunla paylaşanları durdurur. Değişen bir batch'i `--replace` ile yeniden planladığında, task ve kapsam listesi aynıysa bölme ve kapsam sorularına verdiğin kendi cevapların yeni batch'e taşınır, değiştiyse yeniden sorulur (A355).
- Özet, task dosyalarının bildirdiği `## Test exceptions` satırlarını da listeler; batch'i onaylamak tam olarak bu satırları kabul eder (A285), kimsenin bildirmediği bir istisna task'ı park ettirir.
- Bir batch task'ının knowledge adımı notun nereye gideceğini asla sormaz: knowledge sayfası yoksa `batch default (A291)` gerekçesiyle `not_applicable` kaydeder ve sabah tablosuna bir öneri ekler (A291).
- Boş bir `commands.lint`, batch özetinde `proofline doctor --commands` önerisiyle ve bir WARNING ile gösterilir; lint'in bilerek olmadığını söylemek için `commands.lint: none` yaz (A366).
- Pull request'lerde CI check'i olmayan bir proje de batch çalıştırır: her pull request yalnızca commit'inin temiz bir kopyasında build ve test geçtikten sonra birleştirilir ve "verified locally, no CI" der.

Ayrıntılar ve sınırlar: [night mode](../../concepts/night-mode.md).

## İyi alışkanlıklar

- Bir task, bir run, bir branch. Task'lar sıraya girer; paralel task'lar ayrı git worktree ister.
- Merge'i yalnızca `proofline merge <PR>` ile yap. Pull request'in güncel head'indeki check'leri okur ve biri yeşil değilse reddeder; hiç check'i olmayan bir pull request yalnızca commit'inin temiz bir kopyasında build ve test geçtikten sonra birleştirilir.
- COMPLEX bir görevi otonom yürütmek için "bunu sormadan bitir" de; soru, yıkıcı işlem, kapsam değişikliği ve teslim durakları yine geçerlidir.
- Bir gate FAIL olursa fix loop çalışsın (`review.max_fix_rounds`, varsayılan 2). Waiver için bulgu başına açık mesajın gerekir; güvenlik ve secret bulguları waive edilemez.
- Bir test gerçek zamanı beklemek zorundaysa veya yavaş bir ölçüm kaçınılmazsa, plan bunu `## Test exceptions` içinde belirtir; bir satır bir bulguyu yalnızca tam o satırı onayladıysan temizler (A284, A285), plan onayında ya da batch özetinde.
- Runtime limiti dolunca diğer runtime'ı aç ve `proofline resume` çalıştır. Bkz. [failover](../../concepts/failover.md).
- Config değiştirdikten veya yükselttikten sonra `proofline doctor` çalıştır.
- Completion report'taki `## Unsupported Checks` ve `## Assumptions` bölümlerini oku: UNSUPPORTED bir kontrol asla geçmiş sayılmadı, doğrulanmamış bir varsayım ya kabul ettiğin ya da hâlâ taşıdığın bir risktir. Kanıt sınıfları ve anlamları: [evidence](../../concepts/evidence.md).
- Neyin doğrulandığını bil: script'ler test edilmiştir ve Claude-only her senaryo bağımsız bir uçtan uca değerlendirmeden bir noktada geçmiştir (2026-10-13 ile 2026-10-17 arası; STANDARD.tr birkaç kez), ancak hiçbiri güncel sürümde yeniden doğrulanmadı. Implementer olarak Codex ve Codex'ten Claude'a failover gerçek kullanımda çalıştı (2026-10-23 ile 25 arası); diğer Codex rolleri gerçek kullanımda henüz doğrulanmadı. Hook, skill, rol veya control plane değişiklikleri birleşmeden önce ayrıca gerçek oturumlu bir smoke test çalıştırır (geçici bir repoda ucuz bir modelle `run`, `deliver` ve iki task'lı bir `batch`); bu bir örnekleme kontrolüdür, senaryo değerlendirmesi değildir. Tarihli sonuçlar [tests/e2e/README.md](../../../tests/e2e/README.md#current-results) içinde.
- Ara sıra `proofline insights` çalıştır: maliyetin ve tekrar eden başarısızlıkların nerede toplandığını gösterir, hiçbir şeyi değiştirmez.

Daha fazla örnek: [prompt-katalogu.md](prompt-katalogu.md). Kavramlar: [workflow](../../concepts/workflow.md), [gates](../../concepts/gates.md).
