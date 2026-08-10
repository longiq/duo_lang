# Deploy DuoLang lên VPS Oracle Cloud (1 CPU / 1GB RAM)

Web Speech API (STT/TTS) và Service Worker **bắt buộc HTTPS** (trừ localhost), nên cần Nginx làm reverse proxy + chứng chỉ Let's Encrypt.

Nếu chưa có domain riêng, dùng domain miễn phí trỏ thẳng theo IP: `https://<IP-cua-ban-thay-dau-cham-bang-gach-ngang>.sslip.io` (ví dụ IP `123.45.67.89` → domain `123-45-67-89.sslip.io`), không cần đăng ký gì cả, Let's Encrypt cấp cert bình thường cho domain này.

## 1. Mở port 80/443

Oracle Cloud có **2 lớp firewall**, phải mở cả hai:

1. **Oracle Cloud Console**: vào VCN của instance → Security List (hoặc Network Security Group) → Add Ingress Rule → cho phép TCP port 80 và 443 từ `0.0.0.0/0`.
2. **Firewall trong hệ điều hành** (chạy trên VPS, tùy distro):

```bash
# Ubuntu (ufw)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Oracle Linux / firewalld
sudo firewall-cmd --permanent --add-port=80/tcp
sudo firewall-cmd --permanent --add-port=443/tcp
sudo firewall-cmd --reload
# Oracle Linux images cũng dùng iptables riêng, cần thêm:
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || sudo service iptables save
```

## 2. (Khuyến nghị) Thêm swap vì RAM chỉ 1GB

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 3. Cài Node.js, Nginx, Certbot, Git

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -   # Ubuntu/Debian
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx git

# Oracle Linux thì dùng:
# sudo dnf module install -y nodejs:20
# sudo dnf install -y nginx certbot python3-certbot-nginx git
```

## 4. Lấy code và cài dependencies

```bash
sudo useradd -r -m -s /usr/sbin/nologin duolang || true
sudo mkdir -p /opt/duolang
sudo git clone https://github.com/longiq/duo_lang.git /opt/duolang
cd /opt/duolang
sudo npm install --omit=dev
sudo cp .env.example .env
sudo nano .env   # dán GEMINI_API_KEY thật vào
sudo chown -R duolang:duolang /opt/duolang
```

## 5. Chạy app bằng systemd (tự khởi động lại khi crash/reboot)

```bash
sudo cp deploy/duolang.service /etc/systemd/system/duolang.service
sudo systemctl daemon-reload
sudo systemctl enable --now duolang
sudo systemctl status duolang   # kiểm tra chạy OK (active/running)
```

## 6. Cấu hình Nginx + HTTPS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/duolang
sudo nano /etc/nginx/sites-available/duolang   # thay YOUR_DOMAIN bằng domain/sslip.io của bạn
sudo ln -s /etc/nginx/sites-available/duolang /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

sudo certbot --nginx -d YOUR_DOMAIN   # tự động cấp HTTPS + sửa nginx config
```

## 7. Kiểm tra

Mở `https://YOUR_DOMAIN` trên điện thoại (Chrome/Safari) → thử nói → nếu dịch được và nghe lại được là xong. Sau đó dùng menu trình duyệt **"Thêm vào Màn hình chính"** để cài như app.

## Cập nhật code sau này

```bash
cd /opt/duolang
sudo git pull
sudo npm install --omit=dev
sudo systemctl restart duolang
```
