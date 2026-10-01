#include "dstns/rng.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <iomanip>
#include <random>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace dstns {
namespace {
constexpr std::array<std::uint32_t, 64> k{
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
constexpr std::uint32_t rotr(std::uint32_t x, unsigned n) { return (x >> n) | (x << (32U - n)); }

/// High 64 bits of a 64x64 bit product, for the decimal seed conversions.
// __extension__ marks the 128-bit type as a deliberate GCC/Clang extension, so
// -Wpedantic accepts it.
__extension__ typedef unsigned __int128 uint128;
std::uint64_t mul_high(std::uint64_t a, std::uint64_t b) {
    return static_cast<std::uint64_t>((static_cast<uint128>(a) * b) >> 64);
}

std::array<std::uint32_t, 4> philox(std::array<std::uint32_t,4> c, std::array<std::uint32_t,2> key) {
    constexpr std::uint64_t m0=0xD2511F53ULL, m1=0xCD9E8D57ULL;
    for (int round=0; round<10; ++round) {
        const auto p0=m0*c[0], p1=m1*c[2];
        c = {static_cast<std::uint32_t>(p1>>32)^c[1]^key[0], static_cast<std::uint32_t>(p1),
             static_cast<std::uint32_t>(p0>>32)^c[3]^key[1], static_cast<std::uint32_t>(p0)};
        key[0]+=0x9E3779B9U; key[1]+=0xBB67AE85U;
    }
    return c;
}
}

std::string Seed128::hex() const {
    std::ostringstream out; out << "0x" << std::hex << std::setfill('0') << std::setw(16) << high << std::setw(16) << low;
    return out.str();
}

Seed128 Seed128::parse(std::string_view value) {
    if (value.starts_with("0x") || value.starts_with("0X")) value.remove_prefix(2);
    if (value.empty()) throw std::invalid_argument("seed must contain at least 1 digit");
    std::string val_str(value);
    if (val_str.size() > 32) {
        // Deterministically hash 128-char seeds into canonical 32-hex (128-bit) representation
        val_str = sha256(val_str).substr(0, 32);
    }
    std::string padded(32 > val_str.size() ? 32 - val_str.size() : 0, '0');
    padded.append(val_str);
    Seed128 seed;
    auto parse_half = [](std::string_view s) {
        std::uint64_t v{};
        auto [p, e] = std::from_chars(s.data(), s.data() + s.size(), v, 16);
        if (e != std::errc{} || p != s.data() + s.size()) throw std::invalid_argument("invalid hexadecimal seed");
        return v;
    };
    seed.high = parse_half(std::string_view(padded).substr(0, 16));
    seed.low = parse_half(std::string_view(padded).substr(16));
    return seed;
}

std::string Seed128::decimal() const {
    // Long division of the 128-bit value by 10, most significant half first.
    if (high == 0) return std::to_string(low);
    std::string digits;
    std::uint64_t hi = high, lo = low;
    while (hi || lo) {
        // 128-bit / 10 in two 64-bit steps, carrying the remainder across.
        const std::uint64_t hi_q = hi / 10, hi_r = hi % 10;
        // (hi_r * 2^64 + lo) / 10, computed in halves to stay inside 64 bits.
        const std::uint64_t top = (hi_r << 32) | (lo >> 32);
        const std::uint64_t top_q = top / 10, top_r = top % 10;
        const std::uint64_t bottom = (top_r << 32) | (lo & 0xFFFFFFFFULL);
        const std::uint64_t bottom_q = bottom / 10, remainder = bottom % 10;
        hi = hi_q;
        lo = (top_q << 32) | bottom_q;
        digits.push_back(static_cast<char>('0' + remainder));
    }
    return std::string(digits.rbegin(), digits.rend());
}

Seed128 Seed128::from_decimal(std::string_view value) {
    while (!value.empty() && value.front() == ' ') value.remove_prefix(1);
    while (!value.empty() && value.back() == ' ') value.remove_suffix(1);
    if (value.empty() || value.size() > 39) throw std::invalid_argument("seed must be 1 to 39 decimal digits");
    Seed128 seed;
    for (const char c : value) {
        if (c < '0' || c > '9') throw std::invalid_argument("seed must be a decimal integer");
        // seed = seed * 10 + digit, in 128 bits, detecting overflow.
        const std::uint64_t low_product = seed.low * 10;
        const std::uint64_t low_carry = mul_high(seed.low, 10);
        const std::uint64_t high_product = seed.high * 10;
        if (mul_high(seed.high, 10) != 0) throw std::invalid_argument("seed does not fit in 128 bits");
        std::uint64_t high = high_product + low_carry;
        if (high < low_carry) throw std::invalid_argument("seed does not fit in 128 bits");
        const auto digit = static_cast<std::uint64_t>(c - '0');
        const std::uint64_t low = low_product + digit;
        if (low < digit && ++high == 0) throw std::invalid_argument("seed does not fit in 128 bits");
        seed.high = high;
        seed.low = low;
    }
    return seed;
}

Seed128 Seed128::secure() {
    std::random_device rd;
    auto next=[&] { return (static_cast<std::uint64_t>(rd())<<32U)^rd(); };
    return {next(),next()};
}

Seed128 Seed128::secure64() {
    std::random_device rd;
    return {0, (static_cast<std::uint64_t>(rd()) << 32U) ^ rd()};
}

Seed128 Seed128::derive(std::string_view domain) const {
    const std::string payload = hex() + ":" + std::string(domain);
    const std::string hash = sha256(payload);
    return Seed128::parse(std::string_view(hash).substr(0, 32));
}

std::uint32_t DeterministicRng::u32(RngAddress a) const {
    const std::array<std::uint32_t,4> counter{static_cast<std::uint32_t>(a.object),static_cast<std::uint32_t>(a.object>>32),a.purpose,a.draw};
    const auto domain=static_cast<std::uint64_t>(a.domain);
    const std::array<std::uint32_t,2> key{static_cast<std::uint32_t>(seed_.low)^static_cast<std::uint32_t>(seed_.high)^static_cast<std::uint32_t>(domain),
                                         static_cast<std::uint32_t>(seed_.low>>32)^static_cast<std::uint32_t>(seed_.high>>32)^static_cast<std::uint32_t>(domain*0x9E3779B9ULL)};
    return philox(counter,key)[0];
}
std::uint64_t DeterministicRng::u64(RngAddress a) const { const auto hi=u32(a); ++a.draw; return (static_cast<std::uint64_t>(hi)<<32U)|u32(a); }
double DeterministicRng::uniform01(RngAddress a) const { return (static_cast<double>(u32(a))+0.5)/4294967296.0; }
std::uint32_t DeterministicRng::bounded(RngAddress a, std::uint32_t bound) const {
    if (!bound) throw std::invalid_argument("RNG bound must be positive");
    const std::uint32_t threshold=static_cast<std::uint32_t>(-bound)%bound;
    for (;;) { const auto x=u32(a); if(x>=threshold) return x%bound; ++a.draw; }
}

std::string sha256(std::string_view input) {
    std::vector<std::uint8_t> data(input.begin(),input.end()); const auto bits=static_cast<std::uint64_t>(data.size())*8;
    data.push_back(0x80); while((data.size()%64)!=56) data.push_back(0);
    for(int i=7;i>=0;--i) data.push_back(static_cast<std::uint8_t>(bits>>(i*8)));
    std::array<std::uint32_t,8> h{0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    for(std::size_t o=0;o<data.size();o+=64) {
        std::array<std::uint32_t,64> w{};
        for(std::size_t i=0;i<16;++i) w[i]=(std::uint32_t(data[o+i*4])<<24)|(std::uint32_t(data[o+i*4+1])<<16)|(std::uint32_t(data[o+i*4+2])<<8)|data[o+i*4+3];
        for(std::size_t i=16;i<64;++i) { auto s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>3); auto s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>10); w[i]=w[i-16]+s0+w[i-7]+s1; }
        auto [a,b,c,d,e,f,g,hh]=h;
        for(std::size_t i=0;i<64;++i) { auto s1=rotr(e,6)^rotr(e,11)^rotr(e,25); auto ch=(e&f)^((~e)&g); auto t1=hh+s1+ch+k[i]+w[i]; auto s0=rotr(a,2)^rotr(a,13)^rotr(a,22); auto maj=(a&b)^(a&c)^(b&c); auto t2=s0+maj; hh=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2; }
        h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;
    }
    std::ostringstream out; out<<std::hex<<std::setfill('0'); for(auto v:h) out<<std::setw(8)<<v; return out.str();
}
} // namespace dstns
