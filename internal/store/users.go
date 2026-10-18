package store

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type User struct {
	ID         int64  `json:"id"`
	Username   string `json:"username"`
	Email      string `json:"email"`
	Name       string `json:"name"`
	Role       string `json:"role"` // admin | viewer
	Provider   string `json:"provider"`
	ExternalID string `json:"-"`
	Disabled   bool   `json:"disabled"`
	CreatedAt  int64  `json:"created_at"`
	LastLogin  int64  `json:"last_login"`
	// Language is the interface and e-mail language; empty means the server
	// default. LanguageManual is set once the user picks one themselves, so
	// the Entra account language no longer overrides it.
	Language       string `json:"language"`
	LanguageManual bool   `json:"language_manual"`
	hash           string
}

var ErrNotFound = errors.New("not found")

var (
	dummyOnce sync.Once
	dummyHash []byte
)

const userCols = `id,username,email,name,password_hash,role,provider,external_id,disabled,created_at,last_login,language,language_manual`

func scanUser(r interface{ Scan(...any) error }) (*User, error) {
	var u User
	err := r.Scan(&u.ID, &u.Username, &u.Email, &u.Name, &u.hash, &u.Role, &u.Provider, &u.ExternalID, &u.Disabled, &u.CreatedAt, &u.LastLogin, &u.Language, &u.LanguageManual)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &u, err
}

func (m *Meta) UserCount() int {
	var n int
	m.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n
}

func (m *Meta) Users() ([]User, error) {
	rows, err := m.DB.Query(`SELECT ` + userCols + ` FROM users ORDER BY username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *u)
	}
	return out, rows.Err()
}

func (m *Meta) UserByID(id int64) (*User, error) {
	return scanUser(m.DB.QueryRow(`SELECT `+userCols+` FROM users WHERE id=?`, id))
}

func (m *Meta) UserByName(name string) (*User, error) {
	return scanUser(m.DB.QueryRow(`SELECT `+userCols+` FROM users WHERE username=?`, name))
}

func (m *Meta) UserByExternal(provider, ext string) (*User, error) {
	return scanUser(m.DB.QueryRow(`SELECT `+userCols+` FROM users WHERE provider=? AND external_id=?`, provider, ext))
}

func (m *Meta) CheckPassword(username, password string) (*User, error) {
	u, err := m.UserByName(username)
	if err != nil {
		// Spend comparable time to avoid user enumeration.
		dummyOnce.Do(func() { dummyHash, _ = bcrypt.GenerateFromPassword([]byte("dummy"), 12) })
		bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
		return nil, ErrNotFound
	}
	if u.Disabled || u.hash == "" || bcrypt.CompareHashAndPassword([]byte(u.hash), []byte(password)) != nil {
		return nil, ErrNotFound
	}
	return u, nil
}

func (m *Meta) CreateUser(u *User, password string) error {
	hash := ""
	if password != "" {
		h, err := bcrypt.GenerateFromPassword([]byte(password), 12)
		if err != nil {
			return err
		}
		hash = string(h)
	}
	if u.Provider == "" {
		u.Provider = "local"
	}
	if u.Role == "" {
		u.Role = "viewer"
	}
	u.CreatedAt = time.Now().Unix()
	res, err := m.DB.Exec(`INSERT INTO users(username,email,name,password_hash,role,provider,external_id,disabled,created_at,language,language_manual) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		u.Username, u.Email, u.Name, hash, u.Role, u.Provider, u.ExternalID, u.Disabled, u.CreatedAt, u.Language, u.LanguageManual)
	if err != nil {
		return err
	}
	u.ID, _ = res.LastInsertId()
	return nil
}

func (m *Meta) UpdateUser(u *User) error {
	_, err := m.DB.Exec(`UPDATE users SET email=?,name=?,role=?,disabled=?,language=?,language_manual=? WHERE id=?`, u.Email, u.Name, u.Role, u.Disabled, u.Language, u.LanguageManual, u.ID)
	return err
}

// SetUserLanguage stores a user's language; manual marks a choice the user or
// an admin made, as opposed to one taken over from the Entra account.
func (m *Meta) SetUserLanguage(id int64, lang string, manual bool) error {
	_, err := m.DB.Exec(`UPDATE users SET language=?,language_manual=? WHERE id=?`, lang, manual, id)
	return err
}

// LanguageForEmail returns the language of the enabled user with this e-mail
// address, or "" when there is none or the user follows the server default.
func (m *Meta) LanguageForEmail(email string) string {
	var lang string
	m.DB.QueryRow(`SELECT language FROM users WHERE disabled=0 AND language<>'' AND (email=? COLLATE NOCASE OR username=? COLLATE NOCASE) ORDER BY last_login DESC LIMIT 1`, email, email).Scan(&lang)
	return lang
}

func (m *Meta) SetPassword(id int64, password string) error {
	h, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return err
	}
	_, err = m.DB.Exec(`UPDATE users SET password_hash=? WHERE id=?`, string(h), id)
	return err
}

func (m *Meta) DeleteUser(id int64) error {
	_, err := m.DB.Exec(`DELETE FROM users WHERE id=?`, id)
	return err
}

func (m *Meta) TouchLogin(id int64) {
	m.DB.Exec(`UPDATE users SET last_login=? WHERE id=?`, time.Now().Unix(), id)
}

// ---------------------------------------------------------------- sessions

func hashToken(t string) string {
	h := sha256.Sum256([]byte(t))
	return hex.EncodeToString(h[:])
}

func RandomToken(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (m *Meta) CreateSession(userID int64, ttl time.Duration) (string, error) {
	tok := RandomToken(32)
	now := time.Now()
	_, err := m.DB.Exec(`INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)`, hashToken(tok), userID, now.Add(ttl).Unix(), now.Unix())
	return tok, err
}

func (m *Meta) SessionUser(tok string) (*User, error) {
	u, err := scanUser(m.DB.QueryRow(`SELECT u.id,u.username,u.email,u.name,u.password_hash,u.role,u.provider,u.external_id,u.disabled,u.created_at,u.last_login,u.language,u.language_manual
		FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`, hashToken(tok), time.Now().Unix()))
	if err != nil {
		return nil, err
	}
	if u.Disabled {
		return nil, ErrNotFound
	}
	return u, nil
}

func (m *Meta) DeleteSession(tok string) {
	m.DB.Exec(`DELETE FROM sessions WHERE token_hash=?`, hashToken(tok))
}

func (m *Meta) PurgeSessions() {
	m.DB.Exec(`DELETE FROM sessions WHERE expires_at<?`, time.Now().Unix())
}
