#!/usr/bin/env bash
set -e

echo "========================================================"
echo "  Khoi tao moi truong Docker cho Microsoft Rewards..."
echo "========================================================"
echo ""

# 1. Kiem tra Docker va Docker Compose
if ! command -v docker &> /dev/null; then
    echo "[!] Chua tim thay Docker tren may!"
    echo "    Dang tien hanh tu dong cai dat Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker "$USER" 2>/dev/null || true
    echo "[OK] Cai dat Docker thanh cong!"
fi

# 2. Tao cac thu muc can thiet
mkdir -p config diagnostics sessions

# 3. Tu dong dong bo config.json vao thu muc config/
if [ -f "config.json" ]; then
    echo "[1/3] Dong bo config.json vao thu muc config/config.json..."
    cp -f config.json config/config.json
elif [ ! -f "config/config.json" ] && [ -f "config.example.json" ]; then
    echo "[1/3] Tao config/config.json tu config.example.json..."
    cp -f config.example.json config/config.json
else
    echo "[1/3] File config/config.json: OK!"
fi

# 4. Kiem tra file .env
if [ ! -f ".env" ]; then
    if [ -f ".env1" ]; then
        echo "[2/3] Chua co .env, tu dong copy tu .env1..."
        cp .env1 .env
    elif [ -f "env.example" ]; then
        echo "[2/3] Chua co .env, tao tu env.example..."
        cp env.example .env
        echo "--> [Luu y] Vui long mo file .env de dien tai khoan va mat khau!"
    fi
else
    echo "[2/3] File .env: OK!"
fi

# 5. Cap nhat mui gio Viet Nam trong compose.yaml neu chua co
if grep -q "TZ: 'America/Toronto'" compose.yaml 2>/dev/null; then
    sed -i "s/TZ: 'America\/Toronto'/TZ: 'Asia\/Ho_Chi_Minh'/g" compose.yaml
fi

echo ""
echo "[3/3] Dang keo image GHCR va khoi chay container qua Docker Compose..."
echo ""

# 6. Khoi chay Docker Compose
if docker compose version &> /dev/null; then
    docker compose up -d --pull always --no-build
else
    docker-compose pull
    docker-compose up -d --no-build
fi

echo ""
echo "========================================================"
echo "  DOCKER DA KHOI CHAY THANH CONG (Chay ngam 24/7)!"
echo "========================================================"
echo "  - Xem log truc tiep:     docker compose logs -f"
echo "  - Dung container:        docker compose down"
echo "  - Khoi dong lai:         docker compose restart"
echo "========================================================"

