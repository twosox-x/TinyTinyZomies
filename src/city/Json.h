#pragma once
// Minimal JSON reader for city.json (objects, arrays, numbers, strings, bools, null). Not a general
// library: no \u escapes beyond ASCII, numbers are doubles. Throws nothing; parse() returns false on error.
#include <cstdlib>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace ttz::json {

struct Value {
    enum Type { Null, Bool, Number, String, Array, Object } type = Null;
    double num = 0;
    bool b = false;
    std::string str;
    std::vector<Value> arr;
    std::map<std::string, Value> obj;

    const Value& operator[](const std::string& k) const {
        static const Value none;
        auto it = obj.find(k);
        return it == obj.end() ? none : it->second;
    }
    const Value& operator[](size_t i) const {
        static const Value none;
        return i < arr.size() ? arr[i] : none;
    }
    bool has(const std::string& k) const { return obj.count(k) != 0; }
    double n(double def = 0) const { return type == Number ? num : type == Bool ? (b ? 1 : 0) : def; }
    float f(float def = 0) const { return (float)n(def); }
    int i(int def = 0) const { return (int)n(def); }
    size_t size() const { return type == Array ? arr.size() : obj.size(); }
};

class Parser {
public:
    explicit Parser(const std::string& s) : s_(s) {}
    bool parse(Value& out) { ws(); return value(out) && (ws(), true); }

private:
    const std::string& s_;
    size_t p_ = 0;
    void ws() { while (p_ < s_.size() && (s_[p_] == ' ' || s_[p_] == '\n' || s_[p_] == '\r' || s_[p_] == '\t')) ++p_; }
    bool lit(const char* w) {
        size_t n = std::char_traits<char>::length(w);
        if (s_.compare(p_, n, w) != 0) return false;
        p_ += n;
        return true;
    }
    bool string(std::string& out) {
        if (p_ >= s_.size() || s_[p_] != '"') return false;
        ++p_;
        while (p_ < s_.size() && s_[p_] != '"') {
            char c = s_[p_++];
            if (c == '\\' && p_ < s_.size()) {
                char e = s_[p_++];
                switch (e) {
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': out += '\r'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'u': {
                    unsigned v = (unsigned)std::strtoul(s_.substr(p_, 4).c_str(), nullptr, 16);
                    p_ += 4;
                    out += v < 128 ? (char)v : '?';
                    break;
                }
                default: out += e; break;
                }
            } else {
                out += c;
            }
        }
        if (p_ >= s_.size()) return false;
        ++p_;
        return true;
    }
    bool value(Value& v) {
        ws();
        if (p_ >= s_.size()) return false;
        char c = s_[p_];
        if (c == '{') {
            v.type = Value::Object;
            ++p_;
            ws();
            if (p_ < s_.size() && s_[p_] == '}') { ++p_; return true; }
            for (;;) {
                ws();
                std::string k;
                if (!string(k)) return false;
                ws();
                if (p_ >= s_.size() || s_[p_] != ':') return false;
                ++p_;
                if (!value(v.obj[k])) return false;
                ws();
                if (p_ < s_.size() && s_[p_] == ',') { ++p_; continue; }
                if (p_ < s_.size() && s_[p_] == '}') { ++p_; return true; }
                return false;
            }
        }
        if (c == '[') {
            v.type = Value::Array;
            ++p_;
            ws();
            if (p_ < s_.size() && s_[p_] == ']') { ++p_; return true; }
            for (;;) {
                v.arr.emplace_back();
                if (!value(v.arr.back())) return false;
                ws();
                if (p_ < s_.size() && s_[p_] == ',') { ++p_; continue; }
                if (p_ < s_.size() && s_[p_] == ']') { ++p_; return true; }
                return false;
            }
        }
        if (c == '"') { v.type = Value::String; return string(v.str); }
        if (lit("true")) { v.type = Value::Bool; v.b = true; return true; }
        if (lit("false")) { v.type = Value::Bool; v.b = false; return true; }
        if (lit("null")) { v.type = Value::Null; return true; }
        char* end = nullptr;
        v.num = std::strtod(s_.c_str() + p_, &end);
        if (end == s_.c_str() + p_) return false;
        v.type = Value::Number;
        p_ = (size_t)(end - s_.c_str());
        return true;
    }
};

inline bool parse(const std::string& text, Value& out) { return Parser(text).parse(out); }

} // namespace ttz::json
