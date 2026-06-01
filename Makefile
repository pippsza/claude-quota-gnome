UUID = claude-quota@pippsza
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: schemas install link uninstall pack enable disable logs

# Compile the GSettings schema in-tree (needed before install)
schemas:
	glib-compile-schemas schemas/

# Copy everything into the user extensions dir
install: schemas
	mkdir -p "$(EXT_DIR)"
	cp -r extension.js prefs.js stylesheet.css metadata.json schemas "$(EXT_DIR)/"
	@echo "Installed to $(EXT_DIR). Log out / back in (Wayland), then: make enable"

# Dev: symlink the repo so edits land live (still needs relogin on Wayland)
link: schemas
	rm -rf "$(EXT_DIR)"
	ln -s "$(CURDIR)" "$(EXT_DIR)"
	@echo "Symlinked $(EXT_DIR) -> $(CURDIR)"

uninstall:
	rm -rf "$(EXT_DIR)"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# Build a distributable zip
pack: schemas
	gnome-extensions pack --force \
		--extra-source=stylesheet.css \
		--schema=schemas/org.gnome.shell.extensions.claude-quota.gschema.xml .

# Tail shell logs filtered to this extension
logs:
	journalctl -f -o cat /usr/bin/gnome-shell | grep -i claude-quota
