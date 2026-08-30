.PHONY: template render test

template:
	python3 tools/build_template.py

render: template
	python3 tools/render.py config.json

test: template
	python3 tests/validate.py
