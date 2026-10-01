// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/logging.hpp"

#include <sqlite3.h>
#include <chrono>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace dstns {
namespace {
std::string now(){const auto t=std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());std::tm tm{};
#ifdef _WIN32
localtime_s(&tm,&t);
#else
localtime_r(&t,&tm);
#endif
std::ostringstream o;o<<std::put_time(&tm,"%FT%T%z");return o.str();}
void bind_text(sqlite3_stmt*s,int i,const std::string&v){sqlite3_bind_text(s,i,v.c_str(),-1,SQLITE_TRANSIENT);}
}
RuntimeLogger::RuntimeLogger(const std::filesystem::path&dir){std::filesystem::create_directories(dir);system_path_=dir/"system.log";db_path_=(dir/"runtime.db").string();if(sqlite3_open(db_path_.c_str(),&db_)!=SQLITE_OK)throw std::runtime_error("cannot open runtime log database");exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");exec("CREATE TABLE IF NOT EXISTS runtime_metadata(run_id TEXT PRIMARY KEY,seed TEXT,scenario_hash TEXT,started_at TEXT,completed_at TEXT,status TEXT);");exec("CREATE TABLE IF NOT EXISTS lifecycle_log(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT,run_id TEXT,from_state TEXT,to_state TEXT,state_revision INTEGER);");exec("CREATE TABLE IF NOT EXISTS event_schedule(run_id TEXT,event_id INTEGER,type TEXT,start_ppm INTEGER,end_ppm INTEGER,payload_json TEXT,PRIMARY KEY(run_id,event_id,type));");exec("CREATE TABLE IF NOT EXISTS event_log(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT,run_id TEXT,event_id INTEGER,type TEXT,status TEXT,virtual_s INTEGER,payload_json TEXT);");exec("CREATE TABLE IF NOT EXISTS api_log(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT,method TEXT,path TEXT,status INTEGER,latency_us INTEGER);");system("INFO","logging","runtime logger initialized");}
RuntimeLogger::~RuntimeLogger(){if(db_)sqlite3_close(db_);}
void RuntimeLogger::exec(const char*sql){char*error=nullptr;if(sqlite3_exec(db_,sql,nullptr,nullptr,&error)!=SQLITE_OK){std::string msg=error?error:"sqlite error";sqlite3_free(error);throw std::runtime_error(msg);}}
void RuntimeLogger::system(std::string level,std::string component,std::string message){
    // One entry, one line: a request path or error text carrying a decoded
    // newline must not be able to forge entries of its own.
    for(auto& c:message) if(c=='\n'||c=='\r') c=' ';
    std::lock_guard lock(mutex_);std::ofstream out(system_path_,std::ios::app);out<<now()<<" ["<<level<<"] ["<<component<<"] "<<message<<'\n';}
void RuntimeLogger::lifecycle(std::string run,std::string from,std::string to,std::uint64_t rev){std::lock_guard lock(mutex_);sqlite3_stmt*s{};sqlite3_prepare_v2(db_,"INSERT INTO lifecycle_log(ts,run_id,from_state,to_state,state_revision) VALUES(?,?,?,?,?)",-1,&s,nullptr);bind_text(s,1,now());bind_text(s,2,run);bind_text(s,3,from);bind_text(s,4,to);sqlite3_bind_int64(s,5,static_cast<sqlite3_int64>(rev));sqlite3_step(s);sqlite3_finalize(s);std::ofstream out(system_path_,std::ios::app);out<<now()<<" [INFO] [lifecycle] "<<from<<" -> "<<to<<" run="<<run<<'\n';}
void RuntimeLogger::event(std::string run,std::uint64_t id,std::string type,std::string status,std::uint32_t virtual_s,std::string payload){std::lock_guard lock(mutex_);sqlite3_stmt*s{};sqlite3_prepare_v2(db_,"INSERT INTO event_log(ts,run_id,event_id,type,status,virtual_s,payload_json) VALUES(?,?,?,?,?,?,?)",-1,&s,nullptr);bind_text(s,1,now());bind_text(s,2,run);sqlite3_bind_int64(s,3,static_cast<sqlite3_int64>(id));bind_text(s,4,type);bind_text(s,5,status);sqlite3_bind_int(s,6,static_cast<int>(virtual_s));bind_text(s,7,payload);sqlite3_step(s);sqlite3_finalize(s);}
void RuntimeLogger::api(std::string method,std::string path,int status,std::uint64_t latency){std::lock_guard lock(mutex_);sqlite3_stmt*s{};sqlite3_prepare_v2(db_,"INSERT INTO api_log(ts,method,path,status,latency_us) VALUES(?,?,?,?,?)",-1,&s,nullptr);bind_text(s,1,now());bind_text(s,2,method);bind_text(s,3,path);sqlite3_bind_int(s,4,status);sqlite3_bind_int64(s,5,static_cast<sqlite3_int64>(latency));sqlite3_step(s);sqlite3_finalize(s);}
std::vector<std::string> RuntimeLogger::system_tail(std::size_t limit)const{std::lock_guard lock(mutex_);std::ifstream in(system_path_);std::vector<std::string> lines;for(std::string line;std::getline(in,line);)lines.push_back(line);if(lines.size()>limit)lines.erase(lines.begin(),lines.end()-static_cast<std::ptrdiff_t>(limit));return lines;}
void RuntimeLogger::write_file(const std::string& filename, const std::string& content) {
    std::lock_guard lock(mutex_);
    const auto dir = system_path_.parent_path();
    const auto target = dir / filename;
    const auto tmp = dir / (filename + ".tmp");
    {
        std::ofstream out(tmp, std::ios::trunc);
        out << content;
    }
    std::error_code ec;
    std::filesystem::rename(tmp, target, ec);
}
nlohmann::json RuntimeLogger::rows(const std::string&table,std::size_t limit,std::size_t offset)const{if(table!="api_log"&&table!="event_log"&&table!="lifecycle_log")throw std::invalid_argument("unsupported log table");std::lock_guard lock(mutex_);const auto sql="SELECT * FROM "+table+" ORDER BY id DESC LIMIT ? OFFSET ?";sqlite3_stmt*s{};if(sqlite3_prepare_v2(db_,sql.c_str(),-1,&s,nullptr)!=SQLITE_OK)throw std::runtime_error("cannot query runtime log");sqlite3_bind_int64(s,1,static_cast<sqlite3_int64>(limit));sqlite3_bind_int64(s,2,static_cast<sqlite3_int64>(offset));nlohmann::json rows=nlohmann::json::array();while(sqlite3_step(s)==SQLITE_ROW){nlohmann::json row=nlohmann::json::object();for(int i=0;i<sqlite3_column_count(s);++i){const auto*name=sqlite3_column_name(s,i);switch(sqlite3_column_type(s,i)){case SQLITE_INTEGER:row[name]=sqlite3_column_int64(s,i);break;case SQLITE_FLOAT:row[name]=sqlite3_column_double(s,i);break;case SQLITE_TEXT:row[name]=reinterpret_cast<const char*>(sqlite3_column_text(s,i));break;case SQLITE_NULL:row[name]=nullptr;break;default:row[name]="<blob>";}}rows.push_back(std::move(row));}sqlite3_finalize(s);return rows;}
} // namespace dstns

