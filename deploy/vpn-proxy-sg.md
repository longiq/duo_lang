# Kế hoạch deploy DuoLang lên `vpn-proxy-sg`

Máy này (`161.118.195.13`, alias SSH `oracle-vpn`) **hiện đang offline** — SSH port 22 timeout. Toàn bộ phần dưới đã chuẩn bị sẵn để chạy ngay khi máy online.

Khác với `dev-sg` (đã có nginx/certbot và 2 site đang chạy), `vpn-proxy-sg` là máy làm VPN proxy, nên có 2 rủi ro cần kiểm tra trước: **iptables đã có rule VPN** và **port 80/443 có thể đang bị chiếm**.

## Bước 0 — Xác nhận máy đã online

```bash
ssh -o ConnectTimeout=8 oracle-vpn 'hostname; uname -a'
```

Nếu vẫn timeout: kiểm tra instance đã Start trong Oracle Cloud Console, và Security List có cho phép port 22.

## Bước 1 — Khảo sát trước khi thay đổi gì

Chạy nguyên block này, đọc kết quả trước khi sang bước 2:

```bash
ssh oracle-vpn 'bash -s' <<'EOF'
echo "=== OS ==="; cat /etc/os-release | head -2
echo "=== RAM/CPU ==="; nproc; free -h | head -3
echo "=== port 80/443/3000 co bi chiem? ==="; sudo ss -tlnp | grep -E ':(80|443|3000) ' || echo "trong"
echo "=== nginx/node/certbot ==="; for c in nginx node certbot git; do printf "%-8s " $c; command -v $c || echo "-"; done
echo "=== VPN services ==="; systemctl list-units --type=service --state=running --no-pager | grep -iE 'wireguard|openvpn|xray|v2ray|shadowsocks|hysteria|sing-box' || echo "khong thay"
echo "=== iptables hien tai (LUU LAI!) ==="; sudo iptables-save
EOF
```

**Quan trọng:** lưu output `iptables-save` ra file trên máy local để có thể rollback:

```bash
ssh oracle-vpn 'sudo iptables-save' > ~/vpn-proxy-sg-iptables-backup-$(date +%F).txt
```

## Bước 2 — Xử lý xung đột nếu có

| Tình huống | Cách xử lý |
|---|---|
| Port 80/443 đang bị VPN panel chiếm | Đổi DuoLang sang nginx `server_name` riêng (nginx vẫn ghép được nhiều site trên cùng port 80/443) — chỉ cần đảm bảo nginx là process giữ port. Nếu process khác giữ port, phải đổi port của nó hoặc bỏ ý định dùng máy này. |
| Chưa có nginx | `bootstrap.sh` sẽ tự cài. |
| Đã có VPN dùng iptables | `bootstrap.sh` chỉ **insert** rule ACCEPT cho 80/443 phía trên rule REJECT, không xoá rule nào. Vẫn nên so sánh `iptables-save` trước/sau. |
| RAM 1GB | `bootstrap.sh` tự tạo 1GB swap nếu chưa có. |

⚠️ `bootstrap.sh` có gọi `netfilter-persistent save`. Nếu máy VPN đang có rule tạm thời do VPN daemon tự sinh ra, lệnh này sẽ persist luôn cả chúng. Nếu anh không muốn vậy, chạy script với biến môi trường bỏ qua bước lưu, rồi tự lưu sau khi đã review:

```bash
# Xem diff trước khi persist
ssh oracle-vpn 'sudo iptables-save' > /tmp/after.txt
diff ~/vpn-proxy-sg-iptables-backup-*.txt /tmp/after.txt
```

## Bước 3 — DNS

Thêm A record tại nhà cung cấp DNS của `longiq.xyz`:

```
duolang-proxy.longiq.xyz.   A   161.118.195.13
```

(Hoặc bất kỳ subdomain nào anh muốn — chỉ cần khác `duolang.longiq.xyz` đang trỏ về dev-sg.)

Nếu không muốn tạo DNS record, dùng luôn domain miễn phí không cần cấu hình:
`161-118-195-13.sslip.io` — Let's Encrypt cấp cert bình thường cho domain này.

## Bước 4 — Deploy (1 lệnh)

```bash
scp /Users/longiq/duo_lang/deploy/bootstrap.sh oracle-vpn:/tmp/
ssh oracle-vpn 'sudo bash /tmp/bootstrap.sh duolang-proxy.longiq.xyz'
```

Script này idempotent — chạy lại nhiều lần an toàn. Nó tự làm: swap, cài Node 20 + nginx + certbot, mở firewall, clone code, `npm install`, tạo systemd service, cấu hình nginx, và xin cert Let's Encrypt **chỉ khi DNS đã trỏ đúng về IP máy đó**. Nếu DNS chưa xong, script bỏ qua bước cert và báo rõ — chạy lại sau khi DNS propagate là xong.

Script **không bao giờ ghi đè `.env` đã tồn tại**, nên key đã cấu hình không bị mất khi deploy lại.

## Bước 5 — Điền API key

```bash
ssh oracle-vpn 'sudo nano /opt/duolang/.env'   # thay REPLACE_ME bằng key thật
ssh oracle-vpn 'sudo systemctl restart duolang'
```

Có thể dùng chung Gemini API key với dev-sg.

## Bước 6 — Kiểm tra

```bash
ssh oracle-vpn 'systemctl is-active duolang; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/'
curl -s -o /dev/null -w "%{http_code}\n" https://duolang-proxy.longiq.xyz/
```

Sau đó mở trên điện thoại, thử nói 1 câu tiếng Việt, và cài PWA qua "Thêm vào Màn hình chính".

## Rollback

```bash
ssh oracle-vpn 'sudo systemctl disable --now duolang; sudo rm -f /etc/systemd/system/duolang.service /etc/nginx/sites-enabled/duolang; sudo systemctl daemon-reload; sudo nginx -t && sudo systemctl reload nginx'
# iptables: restore từ file backup ở Bước 1
ssh oracle-vpn 'sudo iptables-restore' < ~/vpn-proxy-sg-iptables-backup-YYYY-MM-DD.txt
```
